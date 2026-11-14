"""End-to-end checkpoint selection/evaluation on synthetic text only."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class PipelineTests(unittest.TestCase):
    def test_cli_seed_matches_generation(self):
        import torch
        from model import TinyGPT, generate
        torch.set_num_threads(1)
        config = {'vocab_size': 6, 'width': 4, 'context': 4}
        model = TinyGPT(**config)
        with torch.no_grad():
            for parameter in model.parameters():
                parameter.zero_()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / 'model.pt'
            torch.save({'config': config, 'state': model.state_dict(), 'vocabulary': ['a', 'b']}, checkpoint)
            selection = root / 'selection.json'
            selection.write_text(json.dumps({'winner': str(checkpoint)}))
            torch.manual_seed(37)
            expected = [generate(model, ['a', 'b'], '', 80, 0.6) for _ in range(4)]
            actual = subprocess.run([sys.executable, 'quality.py', 'generate', '--selection', str(selection),
                                     '--count', '4', '--seed', '37', '--max-same-char', '0'],
                                    check=True, capture_output=True, text=True)
            self.assertEqual(actual.stdout.splitlines(), expected)

    def test_fit_ignores_test_file_then_finalizes_saved_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, values in {
                'train': ['こんにちは', 'おはよう', 'ありがとう', '今日は晴れ', 'おやすみ', '今日は雨'],
                'val': ['明日は雨', 'こんばんは'], 'stats': {'synthetic': True}
            }.items():
                (root / f'{name}.json').write_text(json.dumps(values), encoding='utf-8')
            # Deliberately invalid: training must never read the test file.
            (root / 'test.json').write_text('TEST IS SEALED', encoding='utf-8')
            target = root / 'trial'
            subprocess.run([sys.executable, 'quality.py', 'fit', '--data', str(root),
                            '--out', str(target), '--epochs', '2', '--width', '32', '--layers', '2'],
                           check=True, capture_output=True)
            report = json.loads((target / 'report.json').read_text())
            self.assertTrue(report['completed'])
            self.assertEqual(report['best_val_loss'], min(r['val_loss'] for r in report['history']))
            selected = {'winner': str(target / 'best.pt'), 'baseline': str(target / 'best.pt')}
            selection = root / 'selection.json'
            selection.write_text(json.dumps(selected))
            (root / 'test.json').write_text(json.dumps(['明日は晴れ']))
            subprocess.run([sys.executable, 'quality.py', 'finalize', '--data', str(root),
                            '--selection', str(selection), '--out', str(root)],
                           check=True, capture_output=True)
            result = json.loads((root / 'summary.json').read_text())['results']
            self.assertEqual(result['baseline'], result['winner'])
            self.assertEqual(result['winner']['sample_count'], 48)


if __name__ == '__main__':
    unittest.main()
