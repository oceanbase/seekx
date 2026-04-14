# Changelog

All notable changes to seekx are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.3.0] — 2026-04-14

### Added

**`@seekx/openclaw` (new package — `0.3.0`)**
- First published OpenClaw memory-backend plugin: hybrid BM25 + vector search with reranking and CJK support.
- Ships `skills/` directory and `openclaw.plugin.json` for OpenClaw host integration.

**`seekx-core`**
- `--min-score` / `min_result_score` threshold supported by the search pipeline (post-fusion filter).
- Reproducible benchmark workflows with lock-tolerance helpers (`bench/`).

**`seekx` (CLI)**
- `seekx search` accepts `--min-score <n>` to filter out low-confidence results.
- `seekx onboard` supports non-interactive mode (`--yes` / env-driven) for automated setup.
- `--version` and MCP server version are now derived from `package.json` at runtime.

### Changed

**`seekx-core`**
- Replaced `bun:sqlite` with [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) so that `seekx-core` can be loaded by Node.js runtimes (e.g. via `jiti`), removing the hard Bun-only constraint.
- Removed top-level `await` in `db.ts` for compatibility with Node/jiti loaders.

### Fixed

**`@seekx/openclaw`**
- Hardened runtime startup and file-access error paths.
- Removed `openclaw` `peerDependency` (not on npm registry, caused install failures).
- Replaced `workspace:*` with the published `seekx-core` version in the published tarball.

---

## [0.2.3] — 2026-04-10

### Added

- **`seekx` / `seekx-core`**: `README.md` in each published package directory for npm package pages.
- **`seekx` / `seekx-core`**: `description` and `keywords` in `package.json` for npm discovery and listing metadata.

### Changed

- **`seekx-core`**: Released **0.2.1** (patch bump with the npm metadata above).

### Fixed

- **`seekx` (0.2.3)**: Published tarball listed `seekx-core` as `workspace:*`, which npm clients cannot resolve from the registry; dependency is now `seekx-core: ^0.2.1`. **Avoid `seekx@0.2.2`** for installs from npm; use **0.2.3** or later.

---

## [0.2.1] — 2026-04-09

### Fixed

- **CLI (`seekx`)**: npm registry rejected a `.ts` file as `bin`; added a `bin/seekx.js` shim so `npm install -g seekx` installs a working executable.

---

## [0.2.0] — 2026-04-09

### Added

**Core (`seekx-core`)**
- HyDE (Hypothetical Document Embeddings): generate a hypothetical answer and use its embedding as an additional vector retrieval pass.
- Weighted RRF: original query results receive higher weight (2×) than expanded/HyDE results (1×), with top-rank bonus for better fusion quality.
- Position-aware rerank blending: combine RRF ranking with cross-encoder scores instead of relying on reranker alone.
- FTS5 snippet extraction: return highlighted keyword-in-context snippets from full-text search results.
- Persistent LLM response cache with configurable TTL, stored in SQLite alongside the index.
- Dynamic collection sync in watch mode: automatically detect added or removed collections without restarting the watcher.
- Normalized result score filtering: post-fusion threshold (`min_result_score`) to suppress low-confidence results.

**CLI (`seekx`)**
- `seekx onboard` now starts a background real-time indexer after initial setup so the index is ready immediately.
- Progress reporting for both indexing and search operations.
- Improved search output formatting across text, JSON, and Markdown modes.

### Changed

- Refactored CLI command actions and output formatter for consistency.
- Expanded query parsing is now more robust against malformed or empty LLM responses.

### Fixed

- Rerank document mapping: correctly associate reranker scores with their source chunks.
- Global `--json` flag now propagates to all subcommands.
- Configured search defaults (`default_limit`, `rerank`, `min_score`) are now honored correctly.
- `vec_chunks` table cleanup on document deletion; hybrid search mode semantics when vector index is unavailable.
- Watcher per-path indexing no longer skips files in subdirectories.
- Chunk splitting now aligns on word boundaries; overlap windows respect word boundaries to avoid mid-word cuts.

---

## [0.1.0] — 2026-04-08

### Added

**Core (`seekx-core`)**
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
