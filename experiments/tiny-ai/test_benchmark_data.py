import unittest
from benchmark_data import batches, group_key, partition


class BenchmarkDataTests(unittest.TestCase):
    def test_grouped_holdout_is_disjoint_and_complete(self):
        texts = [f'メッセージ {i}！' for i in range(200)] + ['ＡＢＣ！', 'abc', 'ABC?']
        splits = partition(texts)
        groups = {k: {group_key(t) for t in v} for k, v in splits.items()}
        self.assertFalse(groups['train'] & groups['val'])
        self.assertFalse(groups['train'] & groups['test'])
        self.assertFalse(groups['val'] & groups['test'])
        self.assertEqual(set().union(*map(set, splits.values())), set(texts))
        self.assertEqual(partition(texts[::-1]), splits)

    def test_batches_cover_every_example_without_extra_copies(self):
        parts = [[i] * (i % 64 + 2) for i in range(300)]
        packed = batches(parts, 8, seed=42)
        self.assertEqual(sorted(p[0] for b in packed for p in b), list(range(300)))
        self.assertTrue(all(1 <= len(b) <= 8 for b in packed))
        self.assertEqual(packed, batches(parts, 8, seed=42))
        self.assertNotEqual(packed, batches(parts, 8, seed=43))


if __name__ == '__main__':
    unittest.main()
