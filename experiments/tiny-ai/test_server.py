from concurrent.futures import ThreadPoolExecutor
from threading import Event
import unittest
from fastapi.testclient import TestClient
from server import create_app


class ServerTests(unittest.TestCase):
    def test_generation_and_validation(self):
        seen = []
        def generate(prompt):
            seen.append(prompt)
            return prompt + 'そうかも'
        with TestClient(create_app(generate)) as client:
            self.assertEqual(client.get('/health').json(), {'ok': True})
            self.assertEqual(client.post('/generate', json={'prompt': '明日は'}).json(), {'text': '明日はそうかも'})
            for payload in ({'prompt': 'あ' * 49}, {'prompt': 1}, {'prompt': None}, {'prompt': '', 'model': 'other'}):
                self.assertEqual(client.post('/generate', json=payload).status_code, 422)
            self.assertEqual(seen, ['明日は'])

    def test_busy_does_not_queue_and_health_stays_responsive(self):
        started, release = Event(), Event()
        def generate(prompt):
            started.set()
            if not release.wait(5):
                raise RuntimeError('test synchronization timeout')
            return 'できた'
        with TestClient(create_app(generate)) as client, ThreadPoolExecutor(1) as executor:
            work = executor.submit(client.post, '/generate', json={'prompt': ''})
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(client.post('/generate', json={'prompt': ''}).status_code, 503)
                self.assertEqual(client.get('/health').status_code, 200)
            finally:
                release.set()
            self.assertEqual(work.result().json(), {'text': 'できた'})

    def test_failure_releases_lock_without_leaking_input(self):
        calls = []
        def generate(prompt):
            calls.append(prompt)
            if len(calls) == 1:
                raise ValueError('private text')
            return '復旧'
        with TestClient(create_app(generate)) as client:
            failure = client.post('/generate', json={'prompt': '秘密'})
            self.assertEqual(failure.status_code, 503)
            self.assertNotIn('private', failure.text)
            self.assertEqual(client.post('/generate', json={}).json(), {'text': '復旧'})


if __name__ == '__main__':
    unittest.main()
