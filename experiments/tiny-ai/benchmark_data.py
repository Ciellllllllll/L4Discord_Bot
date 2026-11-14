"""Deterministic grouped holdout and padding-efficient batches (standard library only)."""
import hashlib
import json
import random
import unicodedata
from pathlib import Path


def group_key(text):
    normal = unicodedata.normalize('NFKC', text).casefold()
    stripped = ''.join(c for c in normal if not c.isspace()
                       and not unicodedata.category(c).startswith('P'))
    return stripped or normal


def partition(texts):
    splits = {'train': [], 'val': [], 'test': []}
    for text in sorted(set(texts)):
        digest = hashlib.sha256(('tiny-ai-quality-v2:' + group_key(text)).encode()).hexdigest()
        bucket = int(digest[:8], 16) % 10
        name = 'test' if bucket == 0 else 'val' if bucket == 1 else 'train'
        splits[name].append(text)
    if any(not data for data in splits.values()):
        raise ValueError('Each split must have data')
    return splits


def prepare(source, target):
    # Reuse the exact original snapshot. Do not query the changing live database.
    texts = []
    for name in ('train', 'val'):
        texts.extend(json.loads((source / f'{name}.json').read_text(encoding='utf-8')))
    splits = partition(texts)
    target.mkdir(parents=True, exist_ok=False)
    stats = {'format': 2, 'source': 'original cleaned snapshot', 'splits': {}}
    for name, data in splits.items():
        raw = json.dumps(data, ensure_ascii=False).encode('utf-8')
        (target / f'{name}.json').write_bytes(raw)
        stats['splits'][name] = {'messages': len(data), 'chars': sum(map(len, data)),
                                 'sha256': hashlib.sha256(raw).hexdigest()}
    (target / 'stats.json').write_text(json.dumps(stats, indent=2), encoding='utf-8')
    return stats


def batches(parts, size, seed=None):
    if size < 1:
        raise ValueError('batch size must be positive')
    ordered = list(parts)
    rng = random.Random(seed)
    if seed is not None:
        rng.shuffle(ordered)
    # Local buckets preserve variety while reducing padded positions.
    width = size * 32 if seed is not None else max(1, len(ordered))
    result = []
    for start in range(0, len(ordered), width):
        bucket = sorted(ordered[start:start + width], key=len)
        result.extend(bucket[i:i + size] for i in range(0, len(bucket), size))
    if seed is not None:
        rng.shuffle(result)
    return result
