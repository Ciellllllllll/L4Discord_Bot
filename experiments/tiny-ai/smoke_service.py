"""Exercise the production HTTP server with synthetic weights; no private data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, '/app')
import torch
from model import TinyGPT


def main():
    torch.set_num_threads(1)
    with tempfile.TemporaryDirectory() as directory:
        checkpoint = Path(directory) / 'synthetic.pt'
        config = dict(vocab_size=8, width=32, context=64, layers=2)
        model = TinyGPT(**config)
        torch.save(dict(config=config, state=model.state_dict(), vocabulary=list('あいうえ')), checkpoint)
        env = dict(os.environ, TINY_AI_MODEL_PATH=str(checkpoint))
        server = subprocess.Popen([
            sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1',
            '--port', '8790', '--no-access-log',
        ], env=env, cwd='/app')
        try:
            deadline = time.monotonic() + 30
            while True:
                try:
                    with urllib.request.urlopen('http://127.0.0.1:8790/health', timeout=2) as response:
                        assert json.load(response) == {'ok': True}
                    break
                except (urllib.error.URLError, TimeoutError):
                    if server.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError('server did not become healthy')
                    time.sleep(0.1)
            request = urllib.request.Request('http://127.0.0.1:8790/generate',
                data=json.dumps({'prompt': 'あ'}).encode(), headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                text = json.load(response)['text']
                assert isinstance(text, str) and text.startswith('あ') and len(text) <= 65
            print('Production HTTP server loaded synthetic checkpoint and generated text.')
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    main()
