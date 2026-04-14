# seekx-core

Programmatic library for **seekx**: SQLite-backed storage, hybrid search (BM25 + vector + RRF), incremental indexing, file watching, and configuration helpers.

The **[seekx](https://www.npmjs.com/package/seekx)** CLI is built on this package.

## Requirements

- **[Bun](https://bun.sh)** (same major range as the monorepo; see `engines` / CI)
- **TypeScript ≥ 5.8** as a peer dependency — the published entry points are **`.ts` sources** resolved by Bun (or your bundler)

## Install

```bash
npm install seekx-core
```

Optional native bits for vector search: `sqlite-vec` platform packages are declared as optional dependencies; see the main repo for platform support.

## Public API (overview)

Exported from `seekx-core` (see `src/index.ts` in the repo):

| Area | Symbols |
| --- | --- |
| Database | `openDatabase`, `loadSqliteVec`, type `Database` |
| Store | `Store`, chunk/document/collection types |
| Search | `hybridSearch`, `SearchOptions`, `SearchResult`, progress types |
| Client | `SeekxClient`, `l2normalize`, rerank types |
| Config | `loadConfig`, `requireConfig`, getters/setters, `ResolvedConfig`, … |
| Indexing | `indexFile`, `indexDirectory`, progress types |
| Watching | `Watcher`, watch event types |
| Chunking | `chunkDocument`, `Chunk` |
| Tokenizer | `expandForFTS`, `buildFTSQuery` |

Use these modules to embed seekx in scripts, servers, or custom tooling. For end-user workflows (collections, CLI commands, config file layout), prefer the **`seekx`** CLI. For OpenClaw integration, see **[`@seekx/openclaw`](https://www.npmjs.com/package/@seekx/openclaw)** which builds on this library.

## Documentation

- **Architecture and configuration**: [repository README](https://github.com/oceanbase/seekx/blob/main/README.md)
- **Source**: [`packages/core`](https://github.com/oceanbase/seekx/tree/main/packages/core)

## License

MIT — see [LICENSE](https://github.com/oceanbase/seekx/blob/main/LICENSE).
