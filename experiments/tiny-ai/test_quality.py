import unittest
from quality import learning_rate, repetition


class QualityTests(unittest.TestCase):
    def test_warmup_and_decay(self):
        rates = [learning_rate(i, 1000, 0.003, 'cosine') for i in range(1000)]
        self.assertGreater(rates[49], rates[0])
        self.assertAlmostEqual(max(rates), 0.003)
        self.assertAlmostEqual(rates[-1], 0.0003)
        self.assertTrue(all(0 < r <= 0.003 for r in rates))
        self.assertEqual(learning_rate(999, 1000, 0.003, 'fixed'), 0.003)

    def test_repetition_detects_loops(self):
        self.assertGreater(repetition('そうそうそうそうそうそう'), repetition('今日はいい天気ですね'))
        self.assertEqual(repetition('はい'), 0)


if __name__ == '__main__':
    unittest.main()
