# seekx

**Context search engine for your local files** — hybrid BM25 + vector search with incremental indexing and realtime watch.

This package publishes the **`seekx` CLI**. The indexing and search engine lives in [`seekx-core`](https://www.npmjs.com/package/seekx-core).

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1.0** on your `PATH` (the published CLI runs via Bun, not Node)
- An OpenAI-compatible **embedding** API (and optionally rerank / LLM endpoints for expansion and HyDE)

## Install

```bash
npm install -g seekx
```

`seekx-core` is installed automatically as a dependency.

## Quick start

```bash
seekx onboard              # configure API, embedding model, optional SQLite paths
seekx add ~/notes          # index a directory
seekx search "your query"  # hybrid search (BM25 + vector + RRF)
seekx watch                # keep the index in sync with file changes
```

Use `--json` on any command for machine-readable output.

## Documentation

Full guide (configuration, CLI reference, how search works, macOS SQLite notes): **[repository README](https://github.com/oceanbase/seekx/blob/main/README.md)**.

## CLI commands

| Command | Description |
| --- | --- |
| `seekx onboard` | Interactive setup |
| `seekx add <path>` | Index a directory (collection) |
| `seekx collections` | List collections |
| `seekx remove <name>` | Remove a collection |
| `seekx reindex [name]` | Rebuild index |
| `seekx search <query>` | Hybrid search |
| `seekx query <query>` | Hybrid search with query expansion |
| `seekx vsearch <query>` | Vector-only search |
| `seekx get <id>` | Fetch a document by ID |
| `seekx watch` | File watcher |
| `seekx status` | Stats and health |
| `seekx config` | View or edit config |
| `seekx mcp` | Start MCP server (stdio) |

## License

MIT — see [LICENSE](https://github.com/oceanbase/seekx/blob/main/LICENSE).
