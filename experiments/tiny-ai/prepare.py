"""Read-only export on the VPS; raw messages never leave the host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import unicodedata

SQL = """
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
WITH latest AS (
 SELECT DISTINCT ON (guild_id, message_id) guild_id, message_id, content
 FROM message_log.message_logs m
 WHERE message_id IS NOT NULL
   AND log_type IN ('normal', 'edit')
   AND NOT EXISTS (
     SELECT 1 FROM message_log.message_logs d
     WHERE d.guild_id = m.guild_id AND d.message_id = m.message_id
       AND d.log_type = 'delete'
   )
 ORDER BY guild_id, message_id,
   COALESCE(edited_at, time, created_at) DESC NULLS LAST, id DESC
)
SELECT json_build_object('text', content)::text FROM latest
WHERE length(trim(coalesce(content, ''))) > 0;
COMMIT;
"""


def clean(text):
    text = unicodedata.normalize('NFC', text)
    text = re.sub(r'https?://\S+', ' URL ', text)
    text = re.sub(r'<(?:@!?|@&|#)\d+>', ' MENTION ', text)
    text = re.sub(r'<a?:[^:>]+:\d+>', ' EMOJI ', text)
    text = re.sub(r'\b\d{17,20}\b', ' ID ', text)
    # Strip controls and flatten messages; never concatenate different authors
    # as though a chronological neighbour were necessarily a reply.
    text = ''.join(c for c in text if not unicodedata.category(c).startswith('C') or c.isspace())
    return ' '.join(text.split())


def split_messages(messages):
    unique = sorted({clean(s) for s in messages} - {''})
    train, val = [], []
    for text in unique:
        digest = hashlib.sha256(text.encode()).hexdigest()
        (val if int(digest[:8], 16) % 10 == 0 else train).append(text)
    if not train or not val:
        raise ValueError('Need nonempty training and validation sets')
    return train, val


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--container', default='l4discord-postgres-1')
    args = parser.parse_args()
    os.umask(0o077)
    # Refuse replacement of an existing dataset.
    args.out.mkdir(parents=True, exist_ok=False)
    result = subprocess.run(
        ['docker', 'exec', '-i', args.container, 'psql', '-X', '-qAt',
         '-U', 'l4bot', '-d', 'l4discord', '-v', 'ON_ERROR_STOP=1'],
        input=SQL, text=True, encoding='utf-8', capture_output=True, check=True)
    rows = [json.loads(line)['text'] for line in result.stdout.splitlines() if line.strip()]
    train, val = split_messages(rows)
    for name, texts in [('train', train), ('val', val)]:
        (args.out / f'{name}.json').write_text(json.dumps(texts, ensure_ascii=False), encoding='utf-8')
    stats = {'source_messages': len(rows), 'unique_messages': len(train) + len(val),
             'train_messages': len(train), 'val_messages': len(val),
             'train_chars': sum(map(len, train)), 'val_chars': sum(map(len, val)),
             'train_sha256': hashlib.sha256((args.out / 'train.json').read_bytes()).hexdigest()}
    (args.out / 'stats.json').write_text(json.dumps(stats, indent=2), encoding='utf-8')
    print(json.dumps(stats))


if __name__ == '__main__':
    main()
