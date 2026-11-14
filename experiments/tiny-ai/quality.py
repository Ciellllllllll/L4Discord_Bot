"""Bounded sequential search; test.json is opened only after winner selection.

No pretrained model, extra corpus, network calls, or live database writes.
"""
import argparse
import gc
import json
import math
import os
from pathlib import Path
import random
import subprocess
import sys
import time

from benchmark_data import batches, prepare


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def log(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def setup(seed):
    import torch
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.manual_seed(seed)
    random.seed(seed)


def measure(model, parts):
    import torch
    from model import PAD, batch
    model.eval()
    total, count = 0., 0
    with torch.no_grad():
        for group in batches(parts, 8):
            x, y = batch(group)
            loss = torch.nn.functional.cross_entropy(
                model(x).flatten(0, 1), y.flatten(), ignore_index=PAD, reduction='sum')
            total += loss.item()
            count += (y != PAD).sum().item()
    return total / count


def learning_rate(step, total, peak, schedule):
    if schedule == 'fixed':
        return peak
    warmup = min(100, max(1, total // 20))
    if step < warmup:
        return peak * (step + 1) / warmup
    progress = min(1., (step - warmup) / max(1, total - warmup - 1))
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * progress)))


def fit(args):
    import resource
    import torch
    from model import PAD, TinyGPT, batch, chunks
    from run import save_model
    setup(args.seed)
    args.out.mkdir(parents=True, exist_ok=False)
    training_text = read(args.data / 'train.json')
    validation_text = read(args.data / 'val.json')
    vocabulary = sorted(set(''.join(training_text)))
    config = {'vocab_size': len(vocabulary) + 4, 'width': args.width,
              'layers': args.layers, 'context': 64, 'dropout': args.dropout}
    training = chunks(training_text, vocabulary, 64)
    validation = chunks(validation_text, vocabulary, 64)
    model = TinyGPT(**config)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps_per_epoch = len(batches(training, 8, args.seed))
    total_steps = steps_per_epoch * args.epochs
    started = time.monotonic()
    initial = measure(model, validation)
    history = [{'epoch': 0, 'val_loss': initial}]
    best, significant_best, stale, best_epoch = initial, initial, 0, 0
    save_model(args.out / 'best.pt', model, vocabulary, config)
    log({'trial': args.out.name, 'parameters': sum(p.numel() for p in model.parameters()),
         'initial_val_loss': initial})
    step, stop = 0, 'max_epochs'
    for epoch in range(1, args.epochs + 1):
        model.train()
        total, count = 0., 0
        for group in batches(training, 8, args.seed + epoch):
            x, y = batch(group)
            lr = learning_rate(step, total_steps, args.lr, args.schedule)
            for param_group in optimizer.param_groups:
                param_group['lr'] = lr
            optimizer.zero_grad(set_to_none=True)
            loss = torch.nn.functional.cross_entropy(model(x).flatten(0, 1), y.flatten(), ignore_index=PAD)
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite training loss')
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.)
            optimizer.step()
            n = (y != PAD).sum().item()
            total += loss.item() * n
            count += n
            step += 1
        val = measure(model, validation)
        if not math.isfinite(val):
            raise RuntimeError('Nonfinite validation loss')
        row = {'epoch': epoch, 'train_loss': total / count, 'val_loss': val,
               'lr': lr, 'seconds': round(time.monotonic() - started, 2)}
        history.append(row)
        log({'trial': args.out.name, **row})
        if val < best:
            best, best_epoch = val, epoch
            save_model(args.out / 'best.pt', model, vocabulary, config)
        if val < significant_best - 0.005:
            significant_best, stale = val, 0
        else:
            stale += 1
        report = {'name': args.out.name, 'config': config, 'seed': args.seed,
                  'schedule': args.schedule, 'peak_lr': args.lr,
                  'parameters': sum(p.numel() for p in model.parameters()),
                  'best_val_loss': best, 'best_epoch': best_epoch, 'history': history,
                  'completed': False, 'seconds': round(time.monotonic() - started, 2),
                  'peak_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
                  'data_stats': read(args.data / 'stats.json')}
        write(args.out / 'report.json', report)
        if stale >= args.patience:
            stop = 'early_stop'
            break
    report.update(completed=True, stop_reason=stop)
    write(args.out / 'report.json', report)


def repetition(text):
    if len(text) < 6:
        return 0.
    grams = [text[i:i + 3] for i in range(len(text) - 2)]
    return 1 - len(set(grams)) / len(grams)


def finalize(args):
    import torch
    from model import TinyGPT, chunks, generate
    setup(123)
    selection = read(args.selection)
    # Selection is already persisted before the test set is opened.
    test = read(args.data / 'test.json')
    training = read(args.data / 'train.json')
    training_set = set(training)
    prompts = ['', '今日は', '明日は', 'おはよう', 'ありがとう', 'ゲーム', 'それは', 'ちょっと']
    results = {}
    for label, checkpoint_path in [('baseline', selection['baseline']), ('winner', selection['winner'])]:
        checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=True)
        model = TinyGPT(**checkpoint['config'])
        model.load_state_dict(checkpoint['state'])
        vocabulary = checkpoint['vocabulary']
        vocab_set = set(vocabulary)
        test_loss = measure(model, chunks(test, vocabulary, model.context))
        samples = []
        # A fixed generation protocol; not tuned on test results.
        for temperature in (0.6, 0.8):
            for prompt_index, prompt in enumerate(prompts):
                for index in range(3):
                    torch.manual_seed(1000 + prompt_index * 10 + index)
                    output = generate(model, vocabulary, prompt, 60, temperature)
                    continuation = output[len(prompt):]
                    samples.append({'prompt': prompt, 'temperature': temperature, 'text': output,
                                    'exact_training_match': output in training_set,
                                    'repetition': repetition(continuation),
                                    'empty_continuation': not bool(continuation)})
        results[label] = {
            'test_loss': test_loss, 'test_perplexity': math.exp(test_loss),
            'unknown_char_fraction': sum(c not in vocab_set for t in test for c in t) / sum(map(len, test)),
            'sample_count': len(samples),
            'exact_training_matches': sum(s['exact_training_match'] for s in samples),
            'empty_continuations': sum(s['empty_continuation'] for s in samples),
            'mean_repetition': sum(s['repetition'] for s in samples) / len(samples),
            'samples': samples}
        del model, checkpoint
        gc.collect()
    write(args.out / 'evaluation.json', {'selection': selection, 'results': results})
    # Samples can contain private text; keep them only on the VPS by default.
    summary = {k: {a: b for a, b in v.items() if a != 'samples'} for k, v in results.items()}
    write(args.out / 'summary.json', {'selection': selection, 'results': summary})
    log(summary)


def suite(args):
    args.out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    trials = [
        ('baseline', 32, 1, 8, 0.003, 'fixed', 0.1),
        ('tiny-scheduled', 32, 1, 32, 0.003, 'cosine', 0.1),
        ('small', 64, 2, 32, 0.003, 'cosine', 0.1),
        ('medium', 96, 2, 32, 0.002, 'cosine', 0.1),
    ]
    completed = []
    def run_trial(name, width, layers, epochs, lr, schedule, dropout, seed=42):
        remaining = args.budget - (time.monotonic() - started) - 180
        if remaining < 30:
            return False
        command = [sys.executable, __file__, 'fit', '--data', str(args.data),
                   '--out', str(args.out / name), '--width', str(width), '--layers', str(layers),
                   '--epochs', str(epochs), '--lr', str(lr), '--schedule', schedule,
                   '--dropout', str(dropout), '--seed', str(seed)]
        try:
            subprocess.run(command, check=True, timeout=remaining)
        except subprocess.TimeoutExpired:
            log({'trial': name, 'stopped': 'budget'})
        except subprocess.CalledProcessError as error:
            log({'trial': name, 'failed_exit_code': error.returncode})
        report_path = args.out / name / 'report.json'
        if report_path.exists():
            report = read(report_path)
            # A killed run can leave a checkpoint newer than its last report.
            # Only completed runs are eligible for final selection.
            if not report['completed']:
                return False
            completed.append(report)
            write(args.out / 'trials.json', completed)
            return True
        return False
    for trial in trials:
        success = run_trial(*trial)
        if trial[0] == 'baseline' and not success:
            raise RuntimeError('Baseline did not complete')
    if not completed or not (args.out / 'baseline' / 'best.pt').exists():
        raise RuntimeError('Baseline did not complete')
    winner = min(completed, key=lambda r: r['best_val_loss'])
    # Repeat the selected configuration with another seed if budget permits.
    if args.budget - (time.monotonic() - started) > winner['seconds'] * 1.25 + 180:
        run_trial('repeat', winner['config']['width'], winner['config']['layers'],
                  32, winner['peak_lr'], winner['schedule'], winner['config']['dropout'], seed=73)
        winner = min(completed, key=lambda r: r['best_val_loss'])
    selection = {'winner_name': winner['name'], 'winner': str(args.out / winner['name'] / 'best.pt'),
                 'baseline': str(args.out / 'baseline' / 'best.pt'),
                 'criterion': 'minimum validation loss; test never used for selection',
                 'best_val_loss': winner['best_val_loss'],
                 'parameters': winner['parameters'], 'best_epoch': winner['best_epoch'],
                 'elapsed_search_seconds': round(time.monotonic() - started, 2)}
    write(args.out / 'selection.json', selection)
    log({'selected': selection})
    remaining = max(1, args.budget - (time.monotonic() - started))
    subprocess.run([sys.executable, __file__, 'finalize', '--data', str(args.data),
                    '--selection', str(args.out / 'selection.json'), '--out', str(args.out)],
                   check=True, timeout=remaining)


def sample(args):
    import torch
    from model import TinyGPT, generate
    setup(args.seed)
    selection = read(args.selection)
    checkpoint = torch.load(selection['winner'], map_location='cpu', weights_only=True)
    model = TinyGPT(**checkpoint['config'])
    model.load_state_dict(checkpoint['state'])
    # Loading constructs random temporary weights; they must not consume the
    # random sequence promised by the generation seed.
    torch.manual_seed(args.seed)
    for _ in range(args.count):
        print(generate(model, checkpoint['vocabulary'], args.prompt, 80, args.temperature,
                       args.max_same_char))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('fit')
    p.add_argument('--data', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--width', type=int, default=64)
    p.add_argument('--layers', type=int, default=2)
    p.add_argument('--epochs', type=int, default=32)
    p.add_argument('--lr', type=float, default=0.003)
    p.add_argument('--schedule', choices=['fixed', 'cosine'], default='cosine')
    p.add_argument('--dropout', type=float, default=0.1)
    p.add_argument('--patience', type=int, default=6)
    p.add_argument('--seed', type=int, default=42)
    p = sub.add_parser('suite')
    p.add_argument('--data', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--budget', type=int, default=3300)
    p = sub.add_parser('finalize')
    p.add_argument('--data', type=Path, required=True)
    p.add_argument('--selection', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('generate')
    p.add_argument('--selection', type=Path, default=Path('/runs/quality-v2/selection.json'))
    p.add_argument('--prompt', default='')
    p.add_argument('--count', type=int, default=5)
    p.add_argument('--temperature', type=float, default=0.6)
    p.add_argument('--max-same-char', type=int, default=3)
    p.add_argument('--seed', type=int, default=123)
    args = parser.parse_args()
    if args.command == 'prepare':
        log(prepare(args.source, args.out))
    elif args.command == 'fit':
        if args.epochs < 1 or args.patience < 1 or args.lr <= 0:
            parser.error('epochs, patience and lr must be positive')
        fit(args)
    elif args.command == 'suite':
        if args.budget < 240:
            parser.error('budget must be at least 240 seconds')
        suite(args)
    elif args.command == 'finalize':
        finalize(args)
    else:
        sample(args)


if __name__ == '__main__':
    main()
