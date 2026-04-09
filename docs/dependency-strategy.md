# seekx Dependency Strategy

> Version: v1 | Status: Draft | Updated: 2026-04-08

---

## Overview

seekx's dependency choices are governed by a single constraint: **zero native compilation
on install**. Every dependency must either ship pre-compiled binaries or be pure
JavaScript. This is the primary differentiator from qmd (which requires downloading a
3 GB local model and compiling C++ bindings).

---

## Dependency Inventory

### `seekx-core`

| Package | Purpose | Distribution | Friction risk |
|---------|---------|-------------|---------------|
| `@node-rs/jieba` | Chinese tokenization (jieba-rs) | N-API pre-compiled (14 platforms + WASM fallback) | Minimal |
| `sqlite-vec` | Vector kNN search extension | Per-platform pre-compiled (5 platforms) | Medium — see §3 |
| `@modelcontextprotocol/sdk` | MCP server / client | Pure JS | None |
| `yaml` | `config.yml` parsing | Pure JS | None |
| `chokidar` | File watching (`seekx watch`) | Pure JS (`fsevents` optional) | Minimal |

**SQLite driver** (runtime-dependent):

| Runtime | Driver | Notes |
|---------|--------|-------|
| Bun | `bun:sqlite` (built-in) | Zero installation, zero compilation |
| Node.js | `better-sqlite3` | Requires node-gyp / C++ compiler — **not the target runtime** |

### `seekx` CLI

| Package | Purpose | Distribution |
|---------|---------|-------------|
| `commander` | CLI framework | Pure JS |
| `@inquirer/prompts` | Interactive `seekx onboard` | Pure JS |
| `chalk` | Coloured terminal output | Pure JS |

---

## Runtime Choice: Bun vs Node.js

### Why Bun

The central reason is eliminating `better-sqlite3`.

| | Node.js + better-sqlite3 | Bun + bun:sqlite |
|--|--|--|
| Installation | node-gyp C++ compilation | **Built-in, zero install** |
| Requires C++ compiler | Yes (`xcode-select` / `build-essential`) | No |
| Requires Python | Yes (node-gyp) | No |
| ARM64 / Alpine | Historically problematic | Native support |
| TypeScript execution | Needs `tsx` / `ts-node` | **Native** |
| Test runner | Needs vitest / jest | **Built-in** (`bun test`) |
| Package install speed | Baseline | 5–25× faster |

seekx's "zero compilation" promise depends on never requiring node-gyp. Choosing Bun
as the sole target runtime closes that door permanently.

### The One Trade-off

Bun on macOS uses the system SQLite, which is compiled with
`SQLITE_OMIT_LOAD_EXTENSION`. This prevents `sqlite-vec` from loading. With
Node.js + `better-sqlite3` the problem does not exist (the package bundles its own
SQLite with extension support).

The trade-off is deliberate:

- **Eliminated**: C++ compiler requirement (affects all users, all platforms)
- **Introduced**: `brew install sqlite` requirement (affects macOS users only,
  one-command fix, guided by `seekx onboard`)

qmd ships a runtime-detection shim (`db.ts`) to support both runtimes. seekx does
not: maintaining two SQLite driver code paths adds complexity and re-opens the
node-gyp risk for the Node.js path. The Bun-only stance keeps the codebase simpler
and the install story cleaner.

---

## Per-Dependency Friction Analysis

### `@node-rs/jieba` — Minimal friction

- 14 pre-compiled N-API targets cover all mainstream platforms.
- WASM fallback (`@node-rs/jieba-wasm32-wasi`) activates automatically on
  unsupported platforms; segmentation still works, just slightly slower.
- No user action required in any scenario.

### `sqlite-vec` — Medium friction (macOS + Bun)

Three sub-problems:

**a. Platform coverage is narrower than `@node-rs/jieba`**

Five platforms only: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`windows-x64`. Alpine Linux (musl libc) and other minority platforms are not
covered. Users running seekx in a `node:alpine` Docker image will fail to load
the extension.

Mitigation: declare all five `sqlite-vec-*` packages as `optionalDependencies` so
that installation failure on an unsupported platform does not abort `bun install`.
seekx degrades gracefully to BM25-only search.

**b. macOS + Bun: system SQLite blocks `loadExtension`**

Apple's system SQLite is built with `SQLITE_OMIT_LOAD_EXTENSION`. The fix is to
call `BunDatabase.setCustomSQLite()` before opening any database, pointing it at
Homebrew's full-featured build:

```typescript
// packages/core/src/db.ts
if (process.platform === "darwin") {
  for (const p of [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",  // Apple Silicon
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",     // Intel
  ]) {
    try { BunDatabase.setCustomSQLite(p); break; } catch {}
  }
}
```

If neither path exists, the extension load fails silently and vector search is
unavailable. `seekx onboard` detects this and offers to run `brew install sqlite`
(see `docs/onboard-flow.md`).

An escape hatch is available for CI / custom installations:

```bash
SEEKX_SQLITE_PATH=/path/to/libsqlite3.dylib seekx query "..."
```

**c. Changing the embed dimension requires a full reindex**

`sqlite-vec` requires the vector dimension to be fixed at table-creation time.
Switching embed models (e.g. from a 1024-dim to a 1536-dim model) requires
dropping and recreating `vec_chunks`. seekx detects model mismatch at startup
via the `meta` table and warns the user before any write operation.

### `chokidar` / `fsevents` — Minimal friction

On macOS, chokidar optionally uses `fsevents` for native kernel-level file events.
If the optional install fails, chokidar transparently falls back to polling.
The only observable difference is slightly higher latency for `seekx watch`
(polling interval vs. kernel push), which does not affect correctness.

### Remote API Keys — Runtime friction, not install friction

embed / rerank / expand all require network access and a valid API key. This is
not a package installation problem but an onboarding problem. Mitigations:

- `seekx onboard` validates the key with a live health check before saving config.
- BM25 search is always available offline; vector search degrades gracefully when
  the embed API is unreachable.
- `SEEKX_API_KEY` environment variable overrides the config file, making CI
  integration straightforward.

---

## Friction Risk Matrix

| Dependency | Failure probability | Impact | Degradation strategy |
|-----------|--------------------|---------|--------------------|
| Bun not installed | High (new users) | Entire CLI | README prerequisite; future `npx` shim |
| `sqlite-vec` macOS + Bun | Medium | Vector search | Auto-detect; `brew install sqlite` guided by onboard |
| `sqlite-vec` Alpine/musl | Low | Vector search | BM25-only degradation; warn in `seekx status` |
| `@node-rs/jieba` exotic platform | Very low | Chinese tokenization quality | WASM fallback activates automatically |
| `chokidar` fsevents | Very low | Watch latency | Polling fallback, no user action needed |
| API key missing / invalid | Medium (new users) | Embed / Rerank / Expand | BM25 degradation; `seekx onboard` guides setup |
| Wrong embed model (dim mismatch) | Low | Vector search | Startup warning + prompt to run `seekx reindex` |

---

## Package Distribution Checklist

When publishing `seekx` to npm:

- [ ] `optionalDependencies` includes all five `sqlite-vec-*` platform packages
- [ ] `optionalDependencies` includes `@node-rs/jieba` platform packages
  (the main `@node-rs/jieba` package auto-selects the right one)
- [ ] `engines.bun` specifies minimum Bun version (≥ 1.1.0)
- [ ] `bin.seekx` points to the compiled entry point
- [ ] No `node-gyp`, `binding.gyp`, or `native-module` in the dependency tree
- [ ] `bun install -g seekx` smoke-tested on all five target platforms before release
