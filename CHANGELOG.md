# Changelog

All notable changes to seekx are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-04-08

### Added

**Core (`@seekx/core`)**
- SQLite-backed document store with FTS5 full-text search and `sqlite-vec` vector search.
- Chinese-language FTS5 support: pre-tokenization at index time and query expansion at search time using `@node-rs/jieba`.
- Hybrid search pipeline: BM25 + vector KNN → Reciprocal Rank Fusion (RRF) → optional cross-encoder reranking → score normalization (top result = 1.0).
- Markdown-aware chunker: heading-path prefix in embedding content, ~900-token target with 15 % overlap.
- Remote API client (`SeekxClient`) for OpenAI-compatible embed, rerank, and LLM expand endpoints; all methods degrade gracefully on failure.
- L2 normalization of embeddings before insertion so that `vec0` L2 distance equals cosine distance.
- Two-level change detection: `mtime` fast-path, then SHA-1 hash for accurate deduplication.
- `indexDirectory` using Bun's native `Glob` API for recursive file discovery with ignore patterns.
- Real-time file watcher (`chokidar` v4) with configurable debounce and incremental re-indexing.
- YAML configuration (`~/.seekx/config.yml`) with env-var override, per-service and top-level provider tiers, and `writeConfigKey` for targeted updates.

**CLI (`seekx`)**
- 13 commands: `onboard`, `add`, `collections`, `remove`, `reindex`, `search`, `vsearch`, `query`, `get`, `watch`, `status`, `config`, `mcp`.
- `seekx onboard`: interactive setup wizard with six provider presets (SiliconFlow, Zhipu AI, Jina AI, OpenAI, Ollama, Custom) and live API health checks.
- `seekx status`: full index statistics including embedded-chunk coverage, embed model name, and embedding dimension.
- `seekx search` / `vsearch` / `query`: structured output in human-readable, `--json`, `--md`, and `--files` modes.
- MCP server (stdio transport) exposing four tools: `search`, `get`, `list`, `status`.
- Global `--json` flag, defined exit codes, and error conventions.

### Notes

- Requires Bun ≥ 1.1 (runtime).
- Vector search requires `sqlite-vec` and a SQLite ≥ 3.41 (Homebrew on macOS). `seekx onboard` guides users through this setup.
- Multi-tenant support, Feishu/DingTalk connectors, and multi-modal indexing are planned for future releases.
