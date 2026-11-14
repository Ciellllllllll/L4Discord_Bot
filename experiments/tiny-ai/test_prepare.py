import unittest
from prepare import clean, split_messages


class PreparationTests(unittest.TestCase):
    def test_identifiers_and_links(self):
        self.assertEqual(clean('こんにちは <@123456789012345678>\nhttps://example.com/a'),
                         'こんにちは MENTION URL')
        self.assertEqual(clean('<@&123> <#456> <:smile:789>'), 'MENTION MENTION EMOJI')

    def test_no_duplicate_leakage_and_deterministic_split(self):
        texts = [f'テスト文章{i}' for i in range(100)]
        train, val = split_messages(texts + texts)
        self.assertFalse(set(train) & set(val))
        self.assertEqual(len(train) + len(val), 100)
        self.assertEqual((train, val), split_messages(list(reversed(texts))))


if __name__ == '__main__':
    unittest.main()
