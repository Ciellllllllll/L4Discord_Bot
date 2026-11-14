import tempfile
from pathlib import Path
import unittest
import torch
from model import BOS, EOS, PAD, TinyGPT, batch, chunks


class ModelTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1)
        torch.manual_seed(42)

    def test_future_tokens_do_not_change_past_predictions(self):
        for layers in (1, 2):
            model = TinyGPT(12, layers=layers).eval()
            a, b = torch.tensor([[BOS, 4, 5, 6]]), torch.tensor([[BOS, 4, 9, 10]])
            with torch.no_grad():
                torch.testing.assert_close(model(a)[:, :2], model(b)[:, :2])

    def test_chunking_keeps_all_targets(self):
        parts = chunks(['あいうえお'], list('あいうえお'), 3)
        targets = [token for part in parts for token in part[1:]]
        self.assertEqual(targets, [4, 5, 6, 7, 8, EOS])
        _, y = batch(parts + [[BOS, EOS]])
        self.assertEqual(y[-1].tolist(), [EOS, PAD, PAD])

    def test_save_reload_and_learning(self):
        model = TinyGPT(8)
        x = torch.tensor([[BOS, 4, 5], [BOS, 4, 5]])
        y = torch.tensor([[4, 5, EOS], [4, 5, EOS]])
        opt = torch.optim.AdamW(model.parameters(), lr=0.01)
        def loss():
            return torch.nn.functional.cross_entropy(model(x).flatten(0, 1), y.flatten())
        initial = loss().item()
        for _ in range(35):
            opt.zero_grad()
            value = loss()
            value.backward()
            opt.step()
        self.assertLess(loss().item(), initial * 0.3)
        model.eval()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.pt'
            torch.save(model.state_dict(), path)
            restored = TinyGPT(8).eval()
            restored.load_state_dict(torch.load(path, weights_only=True))
            torch.testing.assert_close(model(x), restored(x))


if __name__ == '__main__':
    unittest.main()
