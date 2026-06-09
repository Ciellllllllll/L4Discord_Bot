# Japanese Worker Contract

The Japanese worker is a local-only HTTP process used by the TypeScript bot for Japanese morphological analysis and strict 5-7-5 detection.

## GET /health

Response:

```json
{
  "ok": true
}
```

## POST /analyze/senryu

Request:

```json
{
  "content": "string",
  "rule": [5, 7, 5]
}
```

Response:

```json
{
  "matched": true,
  "text": "上五 中七 下五",
  "phrases": ["上五", "中七", "下五"],
  "error": null
}
```

`matched:false` means no 5-7-5 candidate was found. Worker errors, HTTP errors, timeouts, and invalid responses are separate client failures.

## POST /analyze/morph

Request:

```json
{
  "content": "string"
}
```

Response:

```json
{
  "tokens": [
    {
      "surface": "原神",
      "base": "原神",
      "reading": "ゲンシン",
      "pos": ["名詞", "固有名詞", "一般"],
      "isProperNoun": true,
      "isOov": false
    }
  ],
  "error": null
}
```

URLs, Discord mentions, role mentions, channel mentions, custom emoji, code blocks, and inline code are excluded from analysis on both the TypeScript caller side and the worker side. `/analyze/morph` may return particles and auxiliaries; Pacchi filters them before learning.
