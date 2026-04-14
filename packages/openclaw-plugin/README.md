# @seekx/openclaw

**OpenClaw memory backend powered by seekx** — hybrid BM25 + vector search
with cross-encoder reranking, query expansion, and CJK support.

Drop-in replacement for OpenClaw's built-in memory backend. `memory_search`
and `memory_get` keep working — result quality improves automatically.

## What it does

When installed as the memory slot plugin, every `memory_search` call is routed
through seekx's full pipeline:

```
query → [expansion] → BM25 + vector kNN → RRF fusion → [rerank] → results
```

Each stage degrades gracefully when unavailable — BM25-only mode works with
no API key and no GPU.

| Feature | builtin `memory-core` | seekx |
|---|---|---|
| Full-text search | trigram | BM25 + Jieba (CJK-aware) |
| Semantic search | — | vector kNN (optional) |
| Reranking | — | cross-encoder (optional) |
| Query expansion | — | LLM-based (optional) |
| Auto-recall | — | proactive pre-search on recall-style prompts |
| Citations | — | `Source: path#line` footer (QMD-compatible) |
| Search timeout | — | configurable (default 8 s) |
| Dependencies | bundled | OpenAI-compatible API (optional) |

## Requirements

- **OpenClaw** ≥ 2026.4.0
- **Node** ≥ 22 or **Bun** ≥ 1.1.0
- An **OpenAI-compatible API** for embedding/reranking/expansion (optional —
  BM25-only mode works without it)

## Install

```bash
openclaw plugins install @seekx/openclaw
```

## Configure

Minimal (inherits API credentials from `~/.seekx/config.yml`):

```json5
{
  "plugins": {
    "slots": { "memory": "seekx" },
    "entries": {
      "seekx": { "enabled": true }
    }
  }
}
```

Full setup with SiliconFlow (recommended for CJK):

```json5
{
  "plugins": {
    "slots": { "memory": "seekx" },
    "entries": {
      "seekx": {
        "enabled": true,
        "config": {
          "apiKey":          "sk-xxx",
          "baseUrl":         "https://api.siliconflow.cn/v1",
          "embedModel":      "BAAI/bge-large-zh-v1.5",
          "rerankModel":     "BAAI/bge-reranker-v2-m3",
          "expandModel":     "Qwen/Qwen3-8B",
          "citations":       "auto",
          "searchTimeoutMs": 8000,
          "paths": [
            { "name": "notes", "path": "~/notes" }
          ]
        }
      }
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
openclaw status              # Memory row should show "plugin seekx"
```

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | from `~/.seekx/config.yml` | API key for embed/rerank/expand |
| `baseUrl` | `string` | from `~/.seekx/config.yml` | OpenAI-compatible API base URL |
| `embedModel` | `string` | from `~/.seekx/config.yml` | Embedding model name |
| `rerankModel` | `string` | — | Cross-encoder reranking model (omit to disable) |
| `expandModel` | `string` | — | Query expansion model (omit to disable) |
| `dbPath` | `string` | `~/.seekx/openclaw.db` | SQLite database path |
| `includeOpenClawMemory` | `boolean` | `true` | Index `~/.openclaw/workspace/` |
| `paths` | `array` | `[]` | Extra directories: `[{ name, path, pattern? }]` |
| `searchLimit` | `number` | `6` | Max results per search |
| `citations` | `string` | `"auto"` | `"auto"` / `"on"` / `"off"` — append `Source: path#line` footer |
| `searchTimeoutMs` | `number` | `8000` | Search timeout in ms (0 = disabled) |
| `refreshIntervalMs` | `number` | `300000` | Periodic re-index interval (ms) |
| `autoRecall.enabled` | `boolean` | `true` | Proactive recall on memory-style prompts |
| `autoRecall.maxResults` | `number` | `3` | Max injected matches |
| `autoRecall.minScore` | `number` | `0.2` | Score threshold for injection |
| `autoRecall.maxChars` | `number` | `1200` | Char budget for injected context |
| `autoRecall.minQueryLength` | `number` | `4` | Skip recall for short prompts |

## Provider examples

**OpenAI**

```json5
{
  "baseUrl": "https://api.openai.com/v1",
  "embedModel": "text-embedding-3-small",
  "expandModel": "gpt-4o-mini"
}
```

**Ollama (local, no API key)**

```json5
{
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "ollama",
  "embedModel": "nomic-embed-text"
}
```

## Documentation

- [User Guide](https://github.com/oceanbase/seekx/blob/main/docs/openclaw-plugin-user-guide.md) — full setup, troubleshooting, degraded modes
- [Design Document](https://github.com/oceanbase/seekx/blob/main/docs/openclaw-plugin-design.md) — architecture, data flow, implementation spec
- [Repository](https://github.com/oceanbase/seekx)

## License

MIT
