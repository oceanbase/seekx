# seekx CLI Design

> Version: v1 | Status: Draft | Updated: 2026-04-08

---

## Design Principles

1. **One primary action per command.** Commands do exactly one thing; options modify
   how, not what.
2. **Opinionated defaults, explicit overrides.** `seekx query` runs the full
   hybrid pipeline by default; individual stages can be disabled with flags
   (`--no-rerank`, `--no-expand`).
3. **Output format is separate from command logic.** Every command that produces
   structured data supports `--json`, `--md`, and `--files`. The default is
   human-readable coloured TTY output.
4. **Graceful degradation is silent.** When a capability is unavailable (e.g.,
   no embed API), the command completes with reduced functionality and shows a
   single dim warning line, not a hard error.
5. **Exit codes are scriptable.** 0 = success, 1 = fatal error, 2 = partial
   failure (results returned but some capability was degraded).

---

## Global Flags

These flags are accepted by every command:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | bool | false | Output as JSON (implies `--no-color`) |
| `--md` | bool | false | Output as Markdown |
| `--files` | bool | false | Output file paths only, one per line |
| `--no-color` | bool | false | Disable ANSI colour codes |
| `--db <path>` | string | `~/.seekx/index.sqlite` | Override DB file path |
| `--config <path>` | string | `~/.seekx/config.yml` | Override config file path |
| `--quiet` / `-q` | bool | false | Suppress all output except results |
| `--verbose` / `-v` | bool | false | Print debug info (API calls, timing) |

---

## Commands

### `seekx onboard`

Interactive setup wizard. Documented in full in
[`docs/onboard-flow.md`](onboard-flow.md).

```
seekx onboard [--yes] [--provider <key>] [--skip-health-check] [--no-watch]
```

| Flag | Description |
|------|-------------|
| `-y, --yes` | Accept all defaults, skip confirmations. For CI / scripting. |
| `--provider <key>` | Provider preset: `siliconflow\|zhipu\|jina\|openai\|ollama\|custom` (or set `SEEKX_PROVIDER`). Required when `--yes` is passed. |
| `--skip-health-check` | Skip API connectivity verification. |
| `--no-watch` | Do not start the background watch daemon after setup. |

Exit codes in non-interactive mode:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | User explicitly cancelled (interactive mode only) |
| `2` | Missing required argument (`--provider`, `SEEKX_API_KEY`, etc.) |
| `3` | Health check failed and `--skip-health-check` was not passed |

Environment variable shortcuts for non-interactive mode:

| Variable | Field |
|----------|-------|
| `SEEKX_PROVIDER` | Provider preset key (equivalent to `--provider`) |
| `SEEKX_API_KEY` | `embed.api_key` (also default for rerank/expand) |
| `SEEKX_BASE_URL` | `embed.base_url` (required for `custom` provider) |
| `SEEKX_EMBED_MODEL` | `embed.model` (overrides preset default) |
| `SEEKX_RERANK_MODEL` | `rerank.model` (enables rerank when set) |
| `SEEKX_EXPAND_MODEL` | `expand.model` (enables expand when set) |
| `SEEKX_RERANK_BASE_URL` / `SEEKX_RERANK_API_KEY` | Independent rerank endpoint (falls back to embed values) |
| `SEEKX_EXPAND_BASE_URL` / `SEEKX_EXPAND_API_KEY` | Independent expand endpoint (falls back to embed values) |

```bash
# Minimal: named preset, only API key required
SEEKX_API_KEY=sk-xxx seekx onboard --yes --provider siliconflow

# Full custom endpoint
SEEKX_API_KEY=sk-xxx \
SEEKX_BASE_URL=https://api.siliconflow.cn/v1 \
SEEKX_EMBED_MODEL=BAAI/bge-m3 \
SEEKX_RERANK_MODEL=BAAI/bge-reranker-v2-m3 \
SEEKX_EXPAND_MODEL=Qwen/Qwen3-8B \
  seekx onboard --yes --provider custom --no-watch
```

**Output (interactive):**

```
seekx onboard

Checking environment...
  ✓ BM25 search          (FTS5 + jieba)
  ✓ Vector search        (sqlite-vec loaded)
  ✓ Chinese tokenization (@node-rs/jieba)

? Choose your API provider: › SiliconFlow
? Enter your API key: sk-████████████████

  Validating...
  ✓ Embed API    (200 OK · 1024-dim · 142 ms)
  ✓ Rerank API   (200 OK · 87 ms)
  ✓ Expand API   (200 OK · 231 ms)

✓ Config saved to ~/.seekx/config.yml

Next steps:
  seekx add ~/notes --name notes
  seekx query "搜索内容"
```

---

### `seekx add <path>`

Index a directory (or single file). Scans matching files, chunks content, embeds
chunks, and writes to the index.

```
seekx add <path> [--name <name>] [--pattern <glob>] [--ignore <pattern>]...
```

| Argument / Flag | Required | Default | Description |
|-----------------|----------|---------|-------------|
| `<path>` | Yes | — | Absolute or relative path to index root |
| `--name <name>` | No | basename of `<path>` | Collection name (`[a-zA-Z0-9_-]+`) |
| `--pattern <glob>` | No | `**/*.{md,txt,markdown}` | Files to include |
| `--ignore <pattern>` | No | (none) | Glob to exclude; repeatable |
| `--no-embed` | No | false | Skip embedding (BM25-only index) |

**Examples:**

```bash
seekx add ~/notes
seekx add ~/notes --name notes --ignore "*.tmp" --ignore "archive/**"
seekx add ~/notes --pattern "**/*.md"   # markdown only
seekx add . --name project              # current directory
```

**Output:**

```
Indexing notes (~/notes)...
  ████████████████████░░░░  842 / 1000  84%  3.2s
  Chunks: 4,218   Embedded: 4,218

✓ Collection "notes" indexed — 1,000 files, 4,218 chunks
  Run 'seekx watch --collection notes' to keep it up to date.
```

If the collection already exists, `add` re-indexes it (incremental diff via
mtime → hash). Use `--name` to create an additional collection pointing to the
same path.

---

### `seekx collections`

List all indexed collections with summary statistics.

```
seekx collections [--json] [--md]
```

**Output (TTY):**

```
Collections (2)

  notes       ~/notes              1,000 docs   4,218 chunks   indexed 2 min ago
  work        ~/work/project-a       342 docs   1,891 chunks   indexed 5 hrs ago
```

**Output (`--json`):**

```json
[
  {
    "name": "notes",
    "path": "/Users/xianlin/notes",
    "pattern": "**/*.{md,txt,markdown}",
    "doc_count": 1000,
    "chunk_count": 4218,
    "last_indexed": "2026-04-08T10:00:00Z"
  }
]
```

---

### `seekx remove <name>`

Remove a collection and all its indexed data.

```
seekx remove <name> [--yes]
```

| Flag | Description |
|------|-------------|
| `--yes` | Skip confirmation prompt |

**Output:**

```
Remove collection "notes"? (1,000 docs, 4,218 chunks will be deleted) [y/N]: y
✓ Collection "notes" removed.
```

---

### `seekx search <query>`

BM25 full-text search. Chinese queries are segmented via jieba before matching.

```
seekx search <query> [--collection <name>]... [--limit <n>] [--json] [--md] [--files]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--collection <name>` | all | Restrict to one or more collections (repeatable) |
| `--limit <n>` | 10 | Maximum results |

**Output (TTY):**

```
seekx search "数据库连接池"

  #a3f2b1  92%  notes/infra/postgres.md          PostgreSQL 连接池配置
           "...推荐将 max_connections 设置为 100，connection pool size 建议..."

  #b7d4e9  87%  notes/backend/database.md         Database Best Practices
           "...connection pool should be sized based on the number of threads..."

  #c1a8f3  81%  notes/k8s/postgres-operator.md   PgBouncer 部署指南
           "...PgBouncer 作为连接池中间件，支持 transaction-level pooling..."

  3 results  (BM25 · 42 ms)
```

The short ID (`#a3f2b1`) can be passed to `seekx get` for full content retrieval.
File paths are OSC 8 hyperlinks when the terminal supports it.

---

### `seekx vsearch <query>`

Vector (semantic) search. Requires embed API to be configured.

```
seekx vsearch <query> [--collection <name>]... [--limit <n>] [--json] [--md] [--files]
```

Same flags as `seekx search`. If the embed API is unavailable, exits with code 2
and a warning.

**Output (TTY):**

```
seekx vsearch "k8s pod crash"

  #d9e1a2  0.94  notes/k8s/debug.md              Pod CrashLoopBackOff 排查
           "...查看 Events 字段中的错误信息，常见原因包括镜像拉取失败..."

  #f3b2c1  0.91  notes/k8s/pod-lifecycle.md      Pod 生命周期详解
           "...Init Container 失败会导致 Pod 停留在 Init:CrashLoopBackOff 状态..."

  2 results  (vector · cosine · 187 ms)
```

---

### `seekx query <query>`

Hybrid search: BM25 + vector + RRF fusion + optional rerank. This is the
recommended command for most use cases.

```
seekx query <query>
  [--collection <name>]...
  [--limit <n>]
  [--mode hybrid|bm25|vector]
  [--no-rerank]
  [--no-expand]
  [--json] [--md] [--files]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `hybrid` | Search mode: `hybrid` (BM25+vector+RRF), `bm25`, or `vector` |
| `--no-rerank` | false | Skip cross-encoder reranking |
| `--no-expand` | false | Skip query expansion (LLM rewrite) |

**Output (TTY):**

```
seekx query "k8s pod 无法启动怎么排查"

  Expanded queries:
    → "kubernetes pod CrashLoopBackOff debug"
    → "容器启动失败 排查步骤 日志"

  #d9e1a2  0.97  notes/k8s/debug.md              Pod CrashLoopBackOff 排查
           "...使用 kubectl describe pod <name> 查看 Events 字段..."

  #a3f2b1  0.94  notes/k8s/pod-lifecycle.md      Pod 生命周期与状态机
           "...Waiting 状态中 CrashLoopBackOff 表示容器反复崩溃重启..."

  2 results  (hybrid · expand · rerank · 431 ms)
  ⚠ Vector search unavailable — run 'seekx onboard' to configure embed API
```

**`--json` output schema:**

```json
{
  "query": "k8s pod 无法启动怎么排查",
  "expanded": ["kubernetes pod CrashLoopBackOff debug", "..."],
  "mode": "hybrid",
  "reranked": true,
  "elapsed_ms": 431,
  "results": [
    {
      "docid": "d9e1a2",
      "file": "/Users/xianlin/notes/k8s/debug.md",
      "title": "Pod CrashLoopBackOff 排查",
      "score": 0.97,
      "collection": "notes",
      "snippet": "使用 kubectl describe pod <name> 查看 Events 字段...",
      "start_line": 42,
      "end_line": 67
    }
  ]
}
```

---

### `seekx get <ref>`

Retrieve full content of one or more documents.

```
seekx get <ref> [--line-numbers] [--json] [--md]
```

`<ref>` accepts:

| Format | Example | Description |
|--------|---------|-------------|
| Absolute path | `/Users/xianlin/notes/k8s/debug.md` | Exact file path |
| Relative path | `notes/k8s/debug.md` | Relative to any collection root |
| Short docid | `#d9e1a2` | Returned by `search` / `query` |
| Glob | `notes/k8s/**` | All matching paths across collections |

| Flag | Description |
|------|-------------|
| `--line-numbers` | Prefix each line with its number |

**Output (TTY):**

```
seekx get #d9e1a2

─── notes/k8s/debug.md ────────────────────────────────────
# Pod CrashLoopBackOff 排查

## 症状

Pod 状态显示 `CrashLoopBackOff`，容器反复重启。

## 排查步骤

1. 查看 Pod 描述：`kubectl describe pod <name>`
...
────────────────────────────────────────────────────────────
```

---

### `seekx watch`

Start a real-time file watcher. Monitors all (or specified) collections and
incrementally re-indexes on file changes. Runs until `Ctrl+C`.

```
seekx watch [--collection <name>]...
```

| Flag | Default | Description |
|------|---------|-------------|
| `--collection <name>` | all collections | Watch only specified collections; repeatable |

**Output:**

```
seekx watch

  Watching 2 collections (debounce: 500ms)
  ✓ notes      ~/notes        (1,000 files)
  ✓ work       ~/work/proj    (342 files)

  Press Ctrl+C to stop.

[10:03:21] ~ notes/k8s/debug.md changed → re-indexed (3 chunks, 187ms)
[10:05:44] + notes/k8s/new-guide.md added → indexed (5 chunks, 243ms)
[10:07:12] - notes/k8s/old-doc.md deleted → removed
```

Changes are reflected in the index within the debounce window (default 500ms,
configurable via `watch.debounce_ms` in `config.yml`).

---

### `seekx status`

Show index statistics and (optionally) live provider health.

```
seekx status [--health] [--json]
```

| Flag | Description |
|------|-------------|
| `--health` | Make live API calls to verify provider endpoints |

**Output (TTY, without `--health`):**

```
seekx status

Environment
  ✓ BM25 search          (FTS5 + jieba)
  ✓ Vector search        (sqlite-vec · Homebrew libsqlite3.dylib)
  ✓ Chinese tokenization (@node-rs/jieba)

Provider  (SiliconFlow)
  ~ Embed API    Qwen/Qwen3-Embedding-0.6B   dim=1024  (not verified)
  ~ Rerank API   Qwen/Qwen3-Reranker-0.6B             (not verified)
  ✗ Expand API   not configured
    → seekx config set provider.expand_model <model>

Index  (~/.seekx/index.sqlite · 48 MB)
  Collections   2
  Documents     1,342
  Chunks        6,109
  Embedded      6,109 / 6,109  (100%)
  Last indexed  2 minutes ago
```

**With `--health` (live API calls):**

```
Provider  (SiliconFlow)
  ✓ Embed API    Qwen/Qwen3-Embedding-0.6B   dim=1024  · 142 ms
  ✓ Rerank API   Qwen/Qwen3-Reranker-0.6B             · 87 ms
  ✗ Expand API   not configured
```

**Exit codes for `seekx status`:**

| Code | Meaning |
|------|---------|
| 0 | All configured capabilities functional |
| 1 | A configured (not optional) capability is broken |
| 2 | A capability is missing / degraded but not explicitly configured |

This makes `seekx status` usable as a health probe in scripts or monitoring.

---

### `seekx config`

Read and write configuration values without editing `~/.seekx/config.yml` directly.

```
seekx config set <key> <value>
seekx config get <key>
seekx config list
```

Key format follows YAML path notation with dots:

| Key | Example Value |
|-----|--------------|
| `provider.base_url` | `https://api.siliconflow.cn/v1` |
| `provider.api_key` | `sk-xxx` |
| `provider.embed_model` | `Qwen/Qwen3-Embedding-0.6B` |
| `provider.rerank_model` | `Qwen/Qwen3-Reranker-0.6B` |
| `provider.expand_model` | `Qwen/Qwen3-8B` |
| `embed.base_url` | (override embed-specific endpoint) |
| `rerank.base_url` | (override rerank-specific endpoint) |
| `search.default_limit` | `10` |
| `search.rerank` | `true` |
| `search.min_score` | `0.3` (absolute threshold for vector / rerank raw scores) |
| `watch.debounce_ms` | `500` |

**Examples:**

```bash
seekx config set provider.base_url https://api.siliconflow.cn/v1
seekx config set provider.api_key sk-xxx
seekx config get provider.embed_model
seekx config list
```

`seekx config list` output:

```
provider:
  base_url:      https://api.siliconflow.cn/v1
  embed_model:   Qwen/Qwen3-Embedding-0.6B
  rerank_model:  Qwen/Qwen3-Reranker-0.6B
  expand_model:  (not set)

search:
  default_limit: 10
  rerank:        true
  min_score:     0.3   # absolute threshold for vector / rerank raw scores

watch:
  debounce_ms:   500
```

**Security note:** `api_key` values are masked in `config list` and `config get`
output (shown as `sk-████`). Use `config set` to update; direct YAML edit is
also valid.

---

### `seekx mcp`

Start seekx as an MCP server (stdio transport). Intended to be launched by an
MCP-capable client (Cursor, Claude Desktop, etc.), not run interactively.

```
seekx mcp [--http] [--port <n>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--http` | false | Use HTTP + SSE transport instead of stdio (Phase 2) |
| `--port <n>` | 8181 | HTTP port when `--http` is set |

**Cursor integration (`settings.json`):**

```json
{
  "mcpServers": {
    "seekx": {
      "command": "seekx",
      "args": ["mcp"]
    }
  }
}
```

**Claude Desktop integration (`claude_desktop_config.json`):**

```json
{
  "mcpServers": {
    "seekx": {
      "command": "seekx",
      "args": ["mcp"]
    }
  }
}
```

MCP tools exposed: `search`, `get`, `related`, `save`, `reindex`, `list`,
`status`. Full MCP tool schemas are documented in `seekx-plan.md §7.3`.

---

## Command Summary Table

| Command | Description | Output flag support |
|---------|-------------|---------------------|
| `onboard` | Interactive setup wizard | — |
| `add <path>` | Index a directory | — |
| `collections` | List all collections | `--json`, `--md` |
| `remove <name>` | Remove a collection | — |
| `search <query>` | BM25 keyword search | `--json`, `--md`, `--files` |
| `vsearch <query>` | Vector semantic search | `--json`, `--md`, `--files` |
| `query <query>` | Hybrid search (default) | `--json`, `--md`, `--files` |
| `get <ref>` | Retrieve full document | `--json`, `--md` |
| `watch` | Real-time file watcher | — |
| `status` | Index stats + health | `--json` |
| `config set/get/list` | Config management | — |
| `mcp` | MCP stdio server | — |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Fatal error (missing required arg, DB error, bad config) |
| 2 | Partial success / degraded (results returned with capability warning) |

---

## Error Message Conventions

- **Fatal errors** (exit 1): `✗ Error: <message>` in red, to stderr.
- **Degradation warnings** (exit 2): `⚠ <capability> unavailable — <hint>` in
  yellow, to stderr, after results are written to stdout.
- **Not-found**: `No results found for "<query>"` to stdout, exit 0 (not an
  error).
- **Missing config**: `Config not found. Run 'seekx onboard' to set up seekx.`
  to stderr, exit 1.

---

## Comparison with qmd CLI

| qmd command | seekx equivalent | Notes |
|-------------|-----------------|-------|
| `qmd search` | `seekx search` | Same intent, BM25 |
| `qmd vsearch` | `seekx vsearch` | Same intent, vector |
| `qmd query` | `seekx query` | Same intent, hybrid |
| `qmd get` | `seekx get` | Same intent |
| `qmd status` | `seekx status` | Same intent |
| `qmd mcp` | `seekx mcp` | Same intent |
| `qmd collection add` | `seekx add` | Flattened; no `collection` prefix |
| `qmd collection list` | `seekx collections` | Noun plural |
| `qmd collection remove` | `seekx remove` | Flattened |
| `qmd update` | `seekx add` (re-run) | Incremental diff happens automatically |
| `qmd embed` | _(automatic)_ | Embedding runs during `add` / `watch` |
| `qmd pull` | _(not applicable)_ | No local models |
| `qmd context` | _(Phase 2)_ | Deferred |
| `qmd skill` | _(not applicable)_ | seekx-specific concept absent |
| `qmd bench` | _(Phase 2)_ | Deferred |
| — | `seekx onboard` | New: interactive setup |
| — | `seekx watch` | New: real-time indexing |
| — | `seekx config` | New: config management |
