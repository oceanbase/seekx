# seekx

A context search engine for AI agents and humans.
Your files are the truth, seekx is just the index.
Remote embeddings, realtime index, zero model download.

## Highlights

- **Hybrid search** — full-text (BM25) + semantic (vector) search with Reciprocal Rank Fusion
- **Remote embeddings** — any OpenAI-compatible API; no local model to download or compile
- **Realtime index** — file watcher (`seekx watch`) keeps the index in sync as you edit
- **CJK-ready** — Jieba-based tokenization for Chinese full-text search, no native extension needed
- **Cross-encoder reranking** — optional rerank API for higher-precision results
- **Query expansion** — automatic query rewriting for better recall
- **MCP server** — expose your knowledge base to AI agents (Claude Desktop, Cursor, etc.)

## Comparison with qmd

| Feature | seekx | qmd |
|---|---|---|
| Embedding | Remote API (any OpenAI-compatible endpoint) | Local model (3 GB download + C++ compile) |
| CJK full-text search | ✓ (Jieba tokenization, no native extension) | Limited |
| Real-time indexing | `seekx watch` (chokidar) | No |
| Reranking | Cross-encoder API | No |
| Query expansion | Automatic rewriting | No |
| File types | `.md`, `.txt` (PDF planned) | Markdown only |
| MCP server | Yes (stdio) | No |

## Requirements

- [Bun](https://bun.sh) ≥ 1.1.0
- An OpenAI-compatible embedding API (SiliconFlow, Jina, Ollama, OpenAI, etc.)

### macOS: vector search requires Homebrew SQLite

The system SQLite on macOS disables extension loading. For vector search (`sqlite-vec`):

```bash
brew install sqlite
```

seekx auto-detects standard Homebrew installs, including the usual Apple Silicon
and Intel paths, and also falls back to `brew --prefix sqlite` when available.

Only if auto-detection still fails, set:

```bash
export SEEKX_SQLITE_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
# Add to ~/.zshrc or ~/.bashrc to persist if needed
```

`seekx onboard` will check this and guide you through the fallback.

## Install

```bash
git clone https://github.com/your-org/seekx.git
cd seekx
bun install
bun link --cwd packages/cli   # makes 'seekx' available globally
```

## Quick start

```bash
# Interactive setup (configure API keys, check environment)
seekx onboard

# Index a directory
seekx add ~/notes
seekx add ~/Documents/obsidian --name obsidian

# Search
seekx search "vector database embedding"
seekx query "how does RRF fusion work"   # with automatic query expansion

# Pure semantic search
seekx vsearch "semantic similarity"

# Real-time watcher
seekx watch

# MCP server for AI agents (Claude Desktop, Cursor, etc.)
seekx mcp
```

## Project structure

```
seekx/
├── packages/
│   ├── core/          # @seekx/core — SDK (store, indexer, search, client)
│   │   ├── src/
│   │   │   ├── db.ts          Bun SQLite adapter + sqlite-vec loader
│   │   │   ├── store.ts       Schema, migrations, CRUD
│   │   │   ├── tokenizer.ts   jieba pre-tokenization for FTS5
│   │   │   ├── chunker.ts     Markdown-aware document chunking
│   │   │   ├── indexer.ts     Indexing pipeline (read→chunk→embed→store)
│   │   │   ├── search.ts      Hybrid search (BM25 + vector → RRF → rerank)
│   │   │   ├── client.ts      OpenAI-compatible REST client
│   │   │   ├── config.ts      ~/.seekx/config.yml loader
│   │   │   └── watcher.ts     chokidar real-time file watcher
│   │   └── test/
│   └── cli/           # seekx — CLI
│       └── src/
│           ├── seekx.ts       Commander entry point
│           ├── utils.ts       Context initialization, exit codes
│           ├── formatter.ts   Output formatting (text/JSON/MD)
│           └── commands/      One file per command
└── docs/              # Design documents
```

## Development

```bash
# Run all tests
bun test --recursive packages/

# Type-check
bun run typecheck   # tsc -b packages/core packages/cli

# Lint
bun run lint        # biome check

# Format
bun run format      # biome format --write
```

## Configuration

Config file: `~/.seekx/config.yml`

```yaml
embed:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-...
  model: BAAI/bge-m3

rerank:                         # optional
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-...
  model: BAAI/bge-reranker-v2-m3

expand:                         # optional — automatic query rewriting
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-...
  model: Qwen/Qwen3-8B

search:
  default_limit: 10
  rerank: true
  min_score: 0.3      # absolute threshold for vector / rerank raw scores

watch:
  debounce_ms: 500
  ignore:
    - node_modules
    - .git
```

Environment variable overrides: `SEEKX_API_KEY`, `SEEKX_BASE_URL`, `SEEKX_DB_PATH`, `SEEKX_CONFIG_PATH`, `SEEKX_SQLITE_PATH`.

## License

MIT
