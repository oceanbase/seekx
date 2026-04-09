<p align="center">
  <h1 align="center">seekx</h1>
  <p align="center">
    Context search engine for AI agents and humans.<br/>
    Your files are the truth, seekx is just the index.<br/>
    <b>No GPU. Hybrid Search. Realtime Index.</b>
  </p>
</p>

---

Index once, find anything. seekx brings hybrid search — BM25 keyword precision **plus** semantic understanding — to your local documents. No GPU, no model downloads, no infrastructure. Just your files and a single command.

```
seekx add ~/notes
seekx search "how does raft consensus work"
```

That's it. Your notes are indexed, and you're searching.

## Why seekx?

| Pain point | How seekx solves it |
|---|---|
| Local embedding models are huge and slow to set up | **Remote embeddings** — any OpenAI-compatible API (SiliconFlow, Jina, Ollama, OpenAI…). Zero model download. |
| BM25 or vectors alone miss results | **Hybrid search** — BM25 + vector + RRF fusion. Optional cross-encoder reranking and query expansion for even better recall. |
| Index gets stale as you edit files | **Realtime index** — save a file, search it instantly. The index stays up to date as you work. |
| CJK full-text search is an afterthought | **CJK-ready** — Jieba-based tokenization for Chinese, Japanese, and Korean. No native extension needed. |

## Features

- **Hybrid search** — full-text (BM25) + semantic (vector) with Reciprocal Rank Fusion
- **Cross-encoder reranking** — optional rerank API for higher-precision results
- **Query expansion** — automatic query rewriting for better recall
- **HyDE** — Hypothetical Document Embeddings for improved semantic retrieval
- **Realtime file watcher** — chokidar-based watcher keeps the index in sync as you edit
- **Content-aware chunking** — Markdown heading-based splitting; plain-text paragraph splitting
- **Incremental indexing** — SHA-1 content hashing skips unchanged files; only re-embeds what changed
- **CJK tokenization** — Jieba pre-tokenization for FTS5, no native extension required
- **JSON output** — every command supports `--json` for scripting and piping

## Quick start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1.0
- An OpenAI-compatible embedding API (SiliconFlow, Jina, Ollama, OpenAI, etc.)

### Install

```bash
git clone https://github.com/nicekid1/seekx.git
cd seekx
bun install
bun link --cwd packages/cli   # makes 'seekx' available globally
```

### Set up

```bash
seekx onboard    # interactive — configure API, check environment
```

`onboard` walks you through API key setup, embedding model selection, and macOS SQLite configuration for vector search.

### Index & search

```bash
# Add directories to the index
seekx add ~/notes
seekx add ~/Documents/obsidian --name obsidian

# Hybrid search (BM25 + vector + RRF)
seekx search "vector database embedding"

# Search with automatic query expansion
seekx query "how does RRF fusion work"

# Pure semantic search
seekx vsearch "semantic similarity"
```

### Keep the index fresh

```bash
seekx watch          # watches all indexed collections
```

## CLI reference

| Command | Description |
|---|---|
| `seekx onboard` | Interactive setup wizard |
| `seekx add <path>` | Index a directory (creates a collection) |
| `seekx collections` | List all indexed collections |
| `seekx remove <name>` | Remove a collection |
| `seekx reindex [name]` | Rebuild the index for a collection |
| `seekx search <query>` | Hybrid search (BM25 + vector + RRF) |
| `seekx query <query>` | Hybrid search with query expansion |
| `seekx vsearch <query>` | Pure vector search |
| `seekx get <id>` | Retrieve a document by ID |
| `seekx watch` | Start the realtime file watcher |
| `seekx status` | Show index stats and health |
| `seekx config` | View or update configuration |

All commands support `--json` for machine-readable output.

## Configuration

Config file: `~/.seekx/config.yml`

```yaml
# Provider defaults (shared across services)
provider:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-...

# Embedding — required for vector search
embed:
  model: BAAI/bge-m3

# Cross-encoder reranking — optional
rerank:
  model: BAAI/bge-reranker-v2-m3

# Query expansion — optional
expand:
  model: Qwen/Qwen3-8B

# Search defaults
search:
  default_limit: 10
  rerank: true
  min_score: 0.3

# File watcher
watch:
  debounce_ms: 500
  ignore:
    - node_modules
    - .git
```

Each service (`embed`, `rerank`, `expand`) can override `base_url`, `api_key`, and `model` independently if you use different providers.

### Environment variables

| Variable | Description |
|---|---|
| `SEEKX_API_KEY` | API key (overrides config) |
| `SEEKX_BASE_URL` | Base URL (overrides config) |
| `SEEKX_DB_PATH` | SQLite database path (default: `~/.seekx/index.sqlite`) |
| `SEEKX_CONFIG_PATH` | Config file path (default: `~/.seekx/config.yml`) |
| `SEEKX_SQLITE_PATH` | Path to `libsqlite3.dylib` (macOS, for extension loading) |

### macOS: vector search setup

The system SQLite on macOS disables extension loading. For vector search (`sqlite-vec`):

```bash
brew install sqlite
```

seekx auto-detects standard Homebrew paths (Apple Silicon and Intel). If auto-detection fails:

```bash
export SEEKX_SQLITE_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
```

`seekx onboard` will check this and guide you.

## How search works

```
Query
  │
  ├─► BM25 (FTS5 + Jieba tokenization)  ──► results
  │                                            │
  ├─► Vector (sqlite-vec kNN)            ──► results ──► RRF Fusion ──► [Rerank] ──► Final
  │                                            │
  └─► [Query Expansion / HyDE]          ──► results
```

1. The query is run in parallel against **BM25** (full-text) and **vector** (semantic) indexes.
2. If query expansion or HyDE is enabled, additional retrieval passes are added.
3. All result lists are fused using **Reciprocal Rank Fusion** (RRF).
4. If a reranker is configured, the fused results are re-scored by a cross-encoder.

## Development

```bash
bun test --recursive packages/   # run all tests
bun run typecheck                # tsc -b
bun run lint                     # biome check
bun run format                   # biome format --write
```

## Roadmap

- [ ] MCP server — expose your knowledge base to AI agents (Claude Desktop, Cursor, etc.)
- [ ] PDF and DOCX support
- [ ] Multi-tenancy (isolated indexes per user/workspace)
- [ ] Web UI for search and collection management
- [ ] npm distribution (`npx seekx`)
- [ ] Plugin system for custom file parsers

## License

MIT
