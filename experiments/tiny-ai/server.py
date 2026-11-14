"""Internal, single-model inference endpoint. Never connect this port to the Internet."""
import asyncio
from contextlib import asynccontextmanager
import os
from typing import Callable

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    prompt: str = Field(default='', max_length=48, strict=True)


def load_generator() -> Callable[[str], str]:
    import torch
    from model import TinyGPT, generate
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    checkpoint = torch.load(os.environ.get('TINY_AI_MODEL_PATH', '/model/best.pt'),
                            map_location='cpu', weights_only=True)
    model = TinyGPT(**checkpoint['config'])
    model.load_state_dict(checkpoint['state'])
    model.eval()
    vocabulary = checkpoint['vocabulary']
    return lambda prompt: generate(model, vocabulary, prompt, max_chars=64,
                                   temperature=0.6, max_same_char=3)


def create_app(generator: Callable[[str], str] | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        app.state.generate = generator if generator is not None else load_generator()
        app.state.busy = asyncio.Lock()
        yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get('/health')
    async def health():
        return {'ok': True}

    @app.post('/generate')
    async def generate_reply(body: GenerateRequest):
        if app.state.busy.locked():
            raise HTTPException(503, 'busy')
        async with app.state.busy:
            try:
                text = await run_in_threadpool(app.state.generate, body.prompt)
                if not isinstance(text, str) or len(text) > 160:
                    raise ValueError('invalid generation')
                return {'text': text}
            except Exception:
                # Do not expose a prompt, output, path or exception content.
                raise HTTPException(503, 'generation unavailable') from None

    return app


app = create_app()
