import argparse
import json
import math
import os
from pathlib import Path
import random
import resource
import time

import torch
from torch.nn import functional as F
from model import PAD, TinyGPT, batch, chunks, evaluate, generate


def save_model(path, model, vocabulary, config):
    temp = path.with_suffix('.tmp')
    torch.save({'state': model.state_dict(), 'vocabulary': vocabulary, 'config': config}, temp)
    temp.replace(path)


def train(args):
    if args.epochs < 1 or args.batch_size < 1:
        raise ValueError('epochs and batch-size must be positive')
    args.out.mkdir(parents=True, exist_ok=False)
    train_text = json.loads((args.data / 'train.json').read_text(encoding='utf-8'))
    val_text = json.loads((args.data / 'val.json').read_text(encoding='utf-8'))
    vocabulary = sorted(set(''.join(train_text)))
    config = {'vocab_size': len(vocabulary) + 4, 'width': 32, 'context': 64}
    training = chunks(train_text, vocabulary, config['context'])
    validation = chunks(val_text, vocabulary, config['context'])
    if not training or not validation:
        raise ValueError('Empty dataset')
    model = TinyGPT(**config)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.01)
    params = sum(p.numel() for p in model.parameters())
    started = time.monotonic()
    baseline = evaluate(model, validation)
    history = [{'epoch': 0, 'val_loss': baseline}]
    print(json.dumps({'parameters': params, 'vocabulary': len(vocabulary),
                      'train_chunks': len(training), 'val_chunks': len(validation),
                      'baseline_val_loss': baseline}), flush=True)
    best = baseline
    save_model(args.out / 'best.pt', model, vocabulary, config)
    for epoch in range(1, args.epochs + 1):
        random.shuffle(training)
        model.train()
        total, tokens = 0., 0
        for start in range(0, len(training), args.batch_size):
            x, y = batch(training[start:start + args.batch_size])
            optimizer.zero_grad(set_to_none=True)
            loss = F.cross_entropy(model(x).flatten(0, 1), y.flatten(), ignore_index=PAD)
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite loss')
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            count = (y != PAD).sum().item()
            total += loss.item() * count
            tokens += count
        val_loss = evaluate(model, validation)
        if not math.isfinite(val_loss):
            raise RuntimeError('Nonfinite validation loss')
        row = {'epoch': epoch, 'train_loss': total / tokens, 'val_loss': val_loss,
               'elapsed_seconds': round(time.monotonic() - started, 2)}
        history.append(row)
        print(json.dumps(row), flush=True)
        if val_loss < best:
            best = val_loss
            save_model(args.out / 'best.pt', model, vocabulary, config)
        save_model(args.out / 'last.pt', model, vocabulary, config)
    report = {'parameters': params, 'config': config, 'seed': args.seed, 'epochs': args.epochs,
              'torch_version': str(torch.__version__), 'history': history,
              'best_val_loss': best, 'peak_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
              'elapsed_seconds': round(time.monotonic() - started, 2),
              'data_stats': json.loads((args.data / 'stats.json').read_text(encoding='utf-8'))}
    (args.out / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'finished': True, 'best_val_loss': best, 'peak_rss_mib': report['peak_rss_mib']}), flush=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    training = sub.add_parser('train')
    training.add_argument('--data', type=Path, required=True)
    training.add_argument('--out', type=Path, required=True)
    training.add_argument('--epochs', type=int, default=8)
    training.add_argument('--batch-size', type=int, default=8)
    training.add_argument('--seed', type=int, default=42)
    sampling = sub.add_parser('generate')
    sampling.add_argument('--model', type=Path, required=True)
    sampling.add_argument('--prompt', default='')
    sampling.add_argument('--count', type=int, default=5)
    sampling.add_argument('--max-chars', type=int, default=80)
    sampling.add_argument('--temperature', type=float, default=0.8)
    sampling.add_argument('--seed', type=int, default=123)
    args = parser.parse_args()
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    if args.command == 'train':
        train(args)
    else:
        checkpoint = torch.load(args.model, map_location='cpu', weights_only=True)
        model = TinyGPT(**checkpoint['config'])
        model.load_state_dict(checkpoint['state'])
        for _ in range(args.count):
            print(generate(model, checkpoint['vocabulary'], args.prompt,
                           args.max_chars, args.temperature))


if __name__ == '__main__':
    main()
