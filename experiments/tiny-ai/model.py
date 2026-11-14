"""Small character Transformer, inspired by microgpt/makemore's teaching approach.

Independent PyTorch implementation; no pretrained weights or remote inference.
"""
import torch
from torch import nn
from torch.nn import functional as F

PAD, BOS, EOS, UNK = range(4)


class TinyGPT(nn.Module):
    def __init__(self, vocab_size, width=32, context=64, layers=1, dropout=0.1):
        super().__init__()
        if width % 4 or layers < 1 or context < 1:
            raise ValueError('width must be divisible by 4; layers/context must be positive')
        self.context = context
        self.token = nn.Embedding(vocab_size, width)
        self.position = nn.Embedding(context, width)
        self.block = nn.TransformerEncoderLayer(
            width, nhead=4, dim_feedforward=width * 4, dropout=dropout,
            activation='gelu', batch_first=True, norm_first=True)
        # Keep the first block's keys compatible with the original checkpoint.
        self.extra_blocks = nn.ModuleList([
            nn.TransformerEncoderLayer(
                width, nhead=4, dim_feedforward=width * 4, dropout=dropout,
                activation='gelu', batch_first=True, norm_first=True)
            for _ in range(layers - 1)])
        self.norm = nn.LayerNorm(width)
        self.head = nn.Linear(width, vocab_size, bias=False)
        self.head.weight = self.token.weight
        nn.init.normal_(self.token.weight, std=0.02)
        nn.init.normal_(self.position.weight, std=0.02)

    def forward(self, ids):
        length = ids.shape[1]
        hidden = self.token(ids) + self.position(torch.arange(length, device=ids.device))
        mask = torch.ones(length, length, dtype=torch.bool, device=ids.device).triu(1)
        hidden = self.block(hidden, src_mask=mask)
        for block in self.extra_blocks:
            hidden = block(hidden, src_mask=mask)
        return self.head(self.norm(hidden))


def encode(text, vocabulary):
    lookup = {c: i + 4 for i, c in enumerate(vocabulary)}
    return [lookup.get(c, UNK) for c in text]


def chunks(texts, vocabulary, context):
    result = []
    for text in texts:
        sequence = [BOS] + encode(text, vocabulary) + [EOS]
        for start in range(0, len(sequence) - 1, context):
            part = sequence[start:start + context + 1]
            if len(part) >= 2:
                result.append(part)
    return result


def batch(parts):
    length = max(len(p) - 1 for p in parts)
    x = torch.full((len(parts), length), PAD, dtype=torch.long)
    y = torch.full_like(x, PAD)
    for index, part in enumerate(parts):
        x[index, :len(part) - 1] = torch.tensor(part[:-1])
        y[index, :len(part) - 1] = torch.tensor(part[1:])
    return x, y


@torch.no_grad()
def evaluate(model, parts, batch_size=8):
    model.eval()
    total, count = 0., 0
    for start in range(0, len(parts), batch_size):
        x, y = batch(parts[start:start + batch_size])
        loss = F.cross_entropy(model(x).flatten(0, 1), y.flatten(), ignore_index=PAD, reduction='sum')
        total += loss.item()
        count += (y != PAD).sum().item()
    return total / count


@torch.no_grad()
def generate(model, vocabulary, prompt, max_chars=80, temperature=0.8, max_same_char=0):
    if temperature <= 0:
        raise ValueError('temperature must be positive')
    if max_same_char < 0:
        raise ValueError('max_same_char must be nonnegative')
    model.eval()
    ids = [BOS] + encode(prompt, vocabulary)
    output = prompt
    for _ in range(max_chars):
        x = torch.tensor([ids[-model.context:]], dtype=torch.long)
        logits = model(x)[0, -1] / temperature
        logits[[PAD, BOS, UNK]] = float('-inf')
        next_id = torch.multinomial(logits.softmax(-1), 1).item()
        if next_id == EOS:
            break
        char = vocabulary[next_id - 4]
        continuation = output[len(prompt):]
        if max_same_char and continuation.endswith(char * max_same_char):
            # Stop a pathological run; never modify the supplied prompt or
            # substitute a canned sentence for the model's output.
            break
        ids.append(next_id)
        output += char
    return output
