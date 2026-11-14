"""VPS integration test: use synthetic CTE rows, never production rows."""
import json
import subprocess
import unittest
from prepare import SQL


class ExportTests(unittest.TestCase):
    def test_latest_edits_deletes_and_cross_guild_ids(self):
        fixture = """WITH fixture(id, guild_id, message_id, content, log_type,
                                   edited_at, time, created_at) AS (VALUES
        (1, 1, 10, 'old', 'normal', NULL::text, '2026-01-01', '2026-01-01'),
        (2, 1, 10, 'edited', 'edit', '2026-01-02', '2026-01-02', '2026-01-01'),
        (3, 1, 11, 'removed', 'normal', NULL, '2026-01-01', '2026-01-01'),
        (4, 1, 11, 'removed', 'delete', NULL, '2026-01-02', '2026-01-01'),
        (5, 1, 11, 'late edit after deletion', 'edit', '2026-01-03', '2026-01-03', '2026-01-01'),
        (6, 2, 11, 'other guild', 'normal', NULL, '2026-01-01', '2026-01-01'),
        (7, 1, 12, '   ', 'normal', NULL, '2026-01-01', '2026-01-01'),
        (8, 1, 13, 'edit only', 'edit', '2026-01-02', '2026-01-02', '2026-01-01'),
        (9, 1, NULL, 'missing id', 'normal', NULL, '2026-01-01', '2026-01-01')
        ), latest AS ("""
        query = SQL.replace('message_log.message_logs', 'fixture').replace('WITH latest AS (', fixture)
        result = subprocess.run(
            ['docker', 'exec', '-i', 'l4discord-postgres-1', 'psql', '-X', '-qAt',
             '-U', 'l4bot', '-d', 'l4discord', '-v', 'ON_ERROR_STOP=1'],
            input=query, text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual({json.loads(row)['text'] for row in result.stdout.splitlines()},
                         {'edited', 'other guild', 'edit only'})


if __name__ == '__main__':
    unittest.main()
