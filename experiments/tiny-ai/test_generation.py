import unittest
import torch
from model import generate


class RepeatingModel(torch.nn.Module):
    context = 64

    def forward(self, ids):
        logits = torch.full((*ids.shape, 5), -100.)
        logits[:, :, 4] = 100.
        return logits


class GenerationTests(unittest.TestCase):
    def test_repeat_guard_is_opt_in_and_preserves_prompt(self):
        model = RepeatingModel()
        self.assertEqual(generate(model, ['!'], '', max_chars=6), '!!!!!!')
        self.assertEqual(generate(model, ['!'], '', max_chars=6, max_same_char=3), '!!!')
        self.assertEqual(generate(model, ['!'], 'hello!!!!', max_chars=6, max_same_char=3), 'hello!!!!!!!')


if __name__ == '__main__':
    unittest.main()
