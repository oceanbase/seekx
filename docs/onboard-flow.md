# seekx Onboard Flow Design

> Version: v1 | Status: Draft | Updated: 2026-04-08

---

## Overview

`seekx onboard` is the interactive setup wizard that runs when seekx is used for
the first time (or explicitly re-invoked). It has two goals:

1. **Environment verification** — detect missing system dependencies and guide the
   user to fix them before they hit a confusing runtime error.
2. **Provider configuration** — help the user choose an API provider, enter their
   key, validate it, and write `~/.seekx/config.yml`.

Onboard is idempotent: it can be re-run at any time (e.g. to switch providers or
fix a broken install) and always re-validates the environment from scratch.

---

## Trigger Conditions

`seekx onboard` runs automatically (non-interactively where possible) when:

| Condition | Behaviour |
|-----------|-----------|
| `~/.seekx/config.yml` does not exist | Full onboard wizard |
| Config exists but `provider` section is missing | Skip env check, go to Step 1 |
| Any other `seekx` command runs and config is missing | Print a one-liner prompt and exit: `Run 'seekx onboard' to set up seekx.` |

Explicit invocation (`seekx onboard`) always runs the full flow regardless of
existing config.

---

## Step 0: Environment Check

Runs before asking any questions. Checks each capability and reports status.
If a fixable problem is found, the wizard pauses and offers to resolve it.

### 0-a: sqlite-vec (vector search)

```
Checking environment...

  sqlite-vec   ...
```

**Detection logic (`db.ts`):**

1. Attempt `BunDatabase.setCustomSQLite(homebrewPath)` (macOS only).
2. Open an in-memory database.
3. Call `db.loadExtension(sqliteVecPath)`.
4. If successful → `✓ Vector search  (sqlite-vec loaded)`.
5. If failed on macOS → proceed to guided fix (see below).
6. If failed on other platform → `⚠ Vector search unavailable  (sqlite-vec not
   supported on this platform)`, continue with BM25-only degradation.

**Guided fix (macOS only):**

```
  sqlite-vec   ✗  Cannot load extension (macOS system SQLite blocks loadExtension)

  Vector search requires Homebrew SQLite.

  Fix options:
    [1] Install via Homebrew  →  brew install sqlite   (recommended)
    [2] Set custom path       →  SEEKX_SQLITE_PATH=/path/to/libsqlite3.dylib
    [3] Skip                  →  Continue with BM25-only search

  Choice [1]:
```

- **Option 1**: seekx runs `brew install sqlite` (only after explicit user
  confirmation), then retries the extension load. If it succeeds,
  `✓ Vector search  (sqlite-vec loaded)`.
- **Option 2**: The user provides a path; seekx writes it to config as
  `sqlite_path` and retries.
- **Option 3**: Marks `vector_search: false` in config; all vector-related
  features are silently skipped until the user re-runs onboard.

**Important**: seekx never runs `brew install` without printing the exact command
to be executed and waiting for `[Y/n]` confirmation.

### 0-b: `@node-rs/jieba` (Chinese tokenization)

```
  jieba        ...
```

1. Attempt `import { cut } from '@node-rs/jieba'`.
2. Run `cut('测试', true)` and verify the result is non-empty.
3. If successful → `✓ Chinese tokenization  (@node-rs/jieba)`.
4. If failed (WASM fallback active) → `⚠ Chinese tokenization  (WASM fallback,
   slightly slower — no action needed)`.
5. If completely failed → `✗ Chinese tokenization  (jieba unavailable — reinstall
   seekx)`.

In practice, step 5 should never occur because `@node-rs/jieba` includes a WASM
fallback. It is included for completeness.

### 0-c: Summary before continuing

```
  Environment check complete:

  ✓ BM25 search          (FTS5 + jieba)
  ✓ Vector search        (sqlite-vec loaded)
  ✓ Chinese tokenization (@node-rs/jieba)

  Press Enter to continue with provider setup...
```

If any check failed and the user chose "Skip", the summary shows the degraded
state clearly so the user understands the consequences before proceeding.

---

## Step 1: Choose Provider

```
? Choose your API provider:

  ❯ SiliconFlow    · Recommended for China · All three APIs · Free quota (~14 CNY)
    Zhipu          · China · All three APIs · Free quota
    Volcengine     · China · All three APIs (Doubao) · Free quota
    Jina AI        · International · Embed + Rerank · 1M free tokens
    Cohere         · International · All three APIs · Free quota
    OpenAI         · International · Embed + Expand (no Rerank) · Pay-as-you-go
    Ollama (local) · Local GPU · Embed + Expand (no Rerank)
    Custom         · Any OpenAI-compatible endpoint
```

Provider selection determines the pre-filled defaults for Step 2.

**Capability matrix shown inline:**

| Symbol | Meaning |
|--------|---------|
| ✓ | API available |
| – | Not available from this provider |

```
  Provider capabilities:
    Embed   ✓
    Rerank  ✓
    Expand  ✓  (query rewriting via chat completions)
```

If the provider lacks Rerank or Expand, seekx shows:

```
  ⚠ This provider does not support Rerank.
    Hybrid search will use RRF fusion without cross-encoder reranking.
    You can add a separate Rerank provider later via:
    seekx config set rerank.base_url <url>
```

---

## Step 2: Enter API Key and Models

```
? Enter your API key:  sk-████████████████

  Default models for SiliconFlow:
    Embed model:   Qwen/Qwen3-Embedding-0.6B
    Rerank model:  Qwen/Qwen3-Reranker-0.6B
    Expand model:  Qwen/Qwen3-8B

? Use defaults? [Y/n]:
```

If the user says No, they are prompted for each model name individually.

For **Custom** provider, all fields are prompted:

```
? Base URL:      https://api.example.com/v1
? API Key:       sk-...
? Embed model:   text-embedding-3-small
? Rerank model:  (leave blank to skip Rerank)
? Expand model:  gpt-4o-mini
```

---

## Step 3: Health Check

Validates each configured API before writing config.

```
  Validating provider...

  ✓ Embed API    (200 OK · 1024-dim · 142 ms)
  ✓ Rerank API   (200 OK · 87 ms)
  ✓ Expand API   (200 OK · 231 ms)
```

**On failure:**

```
  ✗ Embed API    (401 Unauthorized)

  The API key was rejected. Please check:
    · Key is correct (no leading/trailing spaces)
    · Key has permission for embeddings
    · Account has remaining quota

  [r] Retry with same key
  [e] Edit key
  [s] Skip health check (not recommended)
```

The embed API dimension returned in the health check response is recorded in
`meta('embed_dim')` and `meta('embed_model')` at this point so that `store.ts`
can create `vec_chunks` with the correct dimension on first use.

---

## Step 4: Write Config

```
  ✓ Config saved to ~/.seekx/config.yml

  Effective configuration:
    Provider:     SiliconFlow
    Base URL:     https://api.siliconflow.cn/v1
    Embed model:  Qwen/Qwen3-Embedding-0.6B  (dim: 1024)
    Rerank model: Qwen/Qwen3-Reranker-0.6B
    Expand model: Qwen/Qwen3-8B
```

The YAML written follows the format documented in `seekx-plan.md §5.4`.

---

## Step 5: Next Steps

```
  Setup complete. Here's how to get started:

    seekx add ~/notes --name notes       # Index a directory
    seekx query "搜索内容"                # Hybrid search
    seekx watch                          # Real-time indexing (keep running)

  To use seekx as an MCP server in Cursor:
    Add to Cursor Settings → MCP Servers:
    { "seekx": { "command": "seekx", "args": ["mcp"] } }

  Run 'seekx status' at any time to check index health.
```

---

## `seekx status` Output Specification

`seekx status` provides the same environment + provider health information as the
onboard check, plus index statistics. It is the go-to command for diagnosing
problems after onboard.

```
$ seekx status

Environment
  ✓ BM25 search          (FTS5 + jieba)
  ✓ Vector search        (sqlite-vec · libsqlite3.dylib)
  ✓ Chinese tokenization (@node-rs/jieba 0.x.x)

Provider  (SiliconFlow)
  ✓ Embed API    Qwen/Qwen3-Embedding-0.6B   dim=1024
  ✓ Rerank API   Qwen/Qwen3-Reranker-0.6B
  ✗ Expand API   not configured  →  seekx config set provider.expand_model <model>

Index  (~/.seekx/index.sqlite)
  Collections   2
  Documents     1,842
  Chunks        9,471
  Embedded      9,471 / 9,471  (100%)
  DB size       48 MB
  Last indexed  2 minutes ago
```

**Key invariants for `seekx status`:**

- Runs read-only; never writes to DB or config.
- Does not make live API calls by default (use `seekx status --health` for live checks).
- Exit code 0 if all configured capabilities are functional, 1 if any configured
  capability is broken (useful for CI / health monitoring scripts).

---

## Non-Interactive Mode

For scripting and CI, all interactive steps can be bypassed via flags and
environment variables.

### Flags

| Flag | Behaviour |
|------|-----------|
| `-y, --yes` | Skip all confirmation prompts; accept safe defaults. |
| `--provider <key>` | Select a preset without the interactive `select` menu. Required when `--yes` is used. |
| `--skip-health-check` | Bypass Step 3 (API connectivity check). Useful when the API is known-good or offline. |
| `--no-watch` | Skip Step 5 (daemon auto-start). |

### Environment variables

| Variable | Effect |
|----------|--------|
| `SEEKX_PROVIDER` | Equivalent to `--provider <key>` |
| `SEEKX_API_KEY` | Embed API key (also default for rerank/expand when using a named preset) |
| `SEEKX_BASE_URL` | Embed base URL (required for `custom` provider) |
| `SEEKX_EMBED_MODEL` | Overrides preset default embed model |
| `SEEKX_RERANK_MODEL` | Sets rerank model; enables rerank in `--yes` mode for `custom` provider |
| `SEEKX_EXPAND_MODEL` | Sets expand model; enables expand in `--yes` mode for `custom` provider |
| `SEEKX_RERANK_BASE_URL` / `SEEKX_RERANK_API_KEY` | Independent rerank endpoint; falls back to embed values |
| `SEEKX_EXPAND_BASE_URL` / `SEEKX_EXPAND_API_KEY` | Independent expand endpoint; falls back to embed values |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Setup complete |
| `1` | User cancelled (interactive mode only) |
| `2` | Missing required arg in `--yes` mode (`--provider`, `SEEKX_API_KEY`, etc.) |
| `3` | Health check failed without `--skip-health-check` |

### Examples

```bash
# Minimal: named preset with API key
SEEKX_API_KEY=sk-xxx seekx onboard --yes --provider siliconflow

# No-key provider (Ollama)
seekx onboard --yes --provider ollama --skip-health-check --no-watch

# Full custom endpoint with rerank and expand
SEEKX_API_KEY=sk-xxx \
SEEKX_BASE_URL=https://api.siliconflow.cn/v1 \
SEEKX_EMBED_MODEL=BAAI/bge-m3 \
SEEKX_RERANK_MODEL=BAAI/bge-reranker-v2-m3 \
SEEKX_EXPAND_MODEL=Qwen/Qwen3-8B \
  seekx onboard --yes --provider custom --no-watch
```

### Behaviour in `--yes` mode per step

| Step | Interactive | `--yes` mode |
|------|-------------|--------------|
| sqlite-vec missing (macOS) | Prompt to continue | Auto-continue; prints `⚠ Continuing without vector search` |
| Provider selection | `select` menu | Must be set via `--provider` or `SEEKX_PROVIDER`; missing → exit 2 |
| API key input | `input` | Must be set via `SEEKX_API_KEY`; missing for `needsKey` presets → exit 2 |
| Model customisation | `confirm` + `input` | Reads from env vars; falls back to preset defaults |
| rerank/expand (custom) | `confirm` per service | Enabled only if `SEEKX_RERANK_MODEL` / `SEEKX_EXPAND_MODEL` is set |
| Health check failure | Prompt to save anyway | Exit 3 (unless `--skip-health-check`) |
| Watch daemon | `confirm` (default yes) | Auto-start (unless `--no-watch`) |
