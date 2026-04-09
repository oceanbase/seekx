<p align="center">
  <img src="assets/hero.png" alt="seekx — Seek Context for AI Agents and You" width="100%">
  <h1 align="center">seekx</h1>
  <p align="center">
    Context search engine for AI agents and humans.<br/>
    Your files are the truth, seekx is just the index.<br/>
    <b>No GPU. Hybrid Search. Realtime Index.</b>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/seekx"><img src="https://img.shields.io/npm/v/seekx" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/seekx"><img src="https://img.shields.io/npm/dm/seekx" alt="npm downloads"></a>
    <a href="https://github.com/oceanbase/seekx/stargazers"><img src="https://img.shields.io/github/stars/oceanbase/seekx" alt="GitHub stars"></a>
    <a href="https://github.com/oceanbase/seekx/blob/main/LICENSE"><img src="https://img.shields.io/github/license/oceanbase/seekx" alt="license"></a>
  </p>
</p>

---

Index once, find anything. seekx brings hybrid search to your local documents — just your files and a single command.

```
seekx add ~/notes
seekx search "how do agents use tool calling"
```

That's it. Your notes are indexed, and you're searching.

## Why seekx?

You have hundreds of Markdown files, notes, docs — scattered across folders. Spotlight finds filenames. Grep finds exact strings. Neither understands what you're *looking for*.

seekx does.

| What you get | How |
|---|---|
| **Find by meaning, not just keywords** | Hybrid search fuses BM25 keyword matching with vector semantic search via RRF — you get results whether you remember the exact words or not. |
| **Up and running in 2 minutes** | No GPU, no model downloads, no Docker. Point it at any OpenAI-compatible API and go. |
| **Always in sync** | Edit a file, search it instantly. The index updates as you work — no manual rebuilds. |
| **Works with Chinese, Japanese, Korean** | Jieba-based tokenization built in. CJK full-text search just works. |

## Features

- **Cross-encoder reranking** — optional rerank API for higher-precision results
- **Query expansion** — automatic query rewriting via LLM for better recall
- **HyDE** — Hypothetical Document Embeddings for improved semantic retrieval
- **Content-aware chunking** — Markdown heading-based splitting; plain-text paragraph splitting
- **Incremental indexing** — SHA-1 content hashing skips unchanged files; only re-embeds what changed
- **JSON output** — every command supports `--json` for scripting and piping

## Quick start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1.0
- An OpenAI-compatible embedding API (SiliconFlow, Jina, Ollama, OpenAI, etc.)

### Install

**From npm (recommended)** — the CLI and library are published on the npm registry: [`seekx`](https://www.npmjs.com/package/seekx) (CLI) depends on [`seekx-core`](https://www.npmjs.com/package/seekx-core). Install the CLI globally; npm pulls `seekx-core` automatically.

```bash
npm install -g seekx
# or: bun add -g seekx
```

You still need [Bun](https://bun.sh) on your `PATH` at runtime — the published CLI runs via Bun, not Node.

**From source** — for development or to run unreleased commits:

```bash
git clone https://github.com/oceanbase/seekx.git
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

## How search works

```
Query
  │
  ├─── [Query Expansion] ──► expanded queries
  │                                │
  ▼                                ▼
  Original query            Expanded queries
  │                                │
  ├─► BM25  (weight 2×)            ├─► BM25  (weight 1×)
  ├─► Vector (weight 2×)           ├─► Vector (weight 1×)
  │                                │
  │   [HyDE] ──► Vector (1×)       │
  │                                │
  └────────── all lists ───────────┘
                  │
              RRF Fusion
                  │
              [Rerank]
                  │
               Final
```

1. **Query expansion** (optional): an LLM rewrites the query into multiple variants for better recall.
2. The original query and all expanded variants are run against **BM25** and **vector** indexes in parallel. Original results carry 2× weight in fusion; expanded results carry 1×.
3. **HyDE** (optional): a hypothetical answer is generated and embedded as an additional vector search pass.
4. All result lists are merged via **Reciprocal Rank Fusion** (RRF).
5. **Reranking** (optional): a cross-encoder re-scores the fused candidates with position-aware blending.

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
- [ ] Plugin system for custom file parsers

## License

MIT
