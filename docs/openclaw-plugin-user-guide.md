# seekx OpenClaw Plugin — User Guide

**Package**: `@seekx/openclaw`  
**Slot**: `plugins.slots.memory`  
**Requires**: OpenClaw ≥ 2026.4.0, Node ≥ 22 or Bun ≥ 1.1.0

---

## What it does

The seekx plugin replaces OpenClaw's built-in memory backend with a
local-first hybrid search engine. When you or the agent calls `memory_search`,
the query is routed through seekx's full pipeline:

```
query
  └─ query expansion (optional)
      ├─ BM25 full-text search  ─┐
      └─ vector kNN search       ├─ RRF fusion → cross-encoder rerank → results
```

OpenClaw's `memory_search` and `memory_get` tool names stay the same.
The agent requires no behavior changes — result quality improves automatically.

**Advantages over the builtin `memory-core` backend:**

| Feature | memory-core | seekx |
|---|---|---|
| Full-text search | trigram | BM25 + Jieba (CJK-aware) |
| Semantic search | — | vector kNN (optional) |
| Reranking | — | cross-encoder (optional) |
| Query expansion | — | LLM-based (optional) |
| Dependencies | bundled | OpenAI-compatible API |

The embedding, reranking, and expansion stages are all optional. Without an
API key, seekx falls back to BM25-only mode and still outperforms the
builtin backend for most queries, especially CJK text.

---

## Requirements

- **OpenClaw** ≥ 2026.4.0 installed and running (`openclaw gateway status`)
- **Node** ≥ 22 LTS **or** **Bun** ≥ 1.1.0
- An **OpenAI-compatible API endpoint** for embedding/reranking/expansion
  (e.g. [SiliconFlow](https://siliconflow.cn), OpenAI, Jina, Ollama)
  — optional, but strongly recommended for semantic search

---

## Installation

### Step 1 — Install the plugin

```bash
openclaw plugins install @seekx/openclaw
```

OpenClaw tries [ClawHub](https://clawhub.dev) first, then npm automatically.

For local development from the seekx monorepo:

```bash
openclaw plugins install -l /path/to/seekx/packages/openclaw-plugin
```

### Step 2 — Configure the plugin

Add the plugin entry to `~/.openclaw/openclaw.json`. The minimal config
inherits API credentials from `~/.seekx/config.yml` if you have seekx
already configured:

```json5
{
  "plugins": {
    "slots": {
      "memory": "seekx"
    },
    "entries": {
      "seekx": {
        "enabled": true
      }
    }
  }
}
```

For a standalone setup (no existing `~/.seekx/config.yml`), provide API
credentials explicitly:

```json5
{
  "plugins": {
    "slots": {
      "memory": "seekx"
    },
    "entries": {
      "seekx": {
        "enabled": true,
        "config": {
          "apiKey":       "sk-xxx",
          "baseUrl":      "https://api.siliconflow.cn/v1",
          "embedModel":   "BAAI/bge-large-zh-v1.5",
          "rerankModel":  "BAAI/bge-reranker-v2-m3",
          "expandModel":  "Qwen/Qwen3-8B"
        }
      }
    }
  }
}
```

### Step 3 — Restart the gateway

```bash
openclaw gateway restart
```

### Step 4 — Verify

```bash
openclaw status
```

Expected output includes a `Memory` row containing `plugin seekx`.
If the gateway has just restarted, `files` and `chunks` may stay at `0`
briefly while the initial index pass completes. Re-run `openclaw status`
after 15 seconds if needed.

If the row shows `plugin seekx · vector off`, the plugin is still working
correctly in BM25-only mode. This means vector search is not active because no
embedding model is configured or `sqlite-vec` is unavailable.

---

## Configuration reference

All fields are optional. Fields not set in `plugins.entries.seekx.config`
inherit from `~/.seekx/config.yml` when that file exists.

### API credentials

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | from `~/.seekx/config.yml` | API key for the embedding/reranking/expansion endpoint. Mark as sensitive in config UIs. |
| `baseUrl` | `string` | from `~/.seekx/config.yml` | OpenAI-compatible API base URL. Examples: `https://api.siliconflow.cn/v1`, `https://api.openai.com/v1`, `http://localhost:11434/v1` |
| `embedModel` | `string` | from `~/.seekx/config.yml` | Embedding model name. Examples: `BAAI/bge-large-zh-v1.5`, `text-embedding-3-small`. Required for vector search. |
| `rerankModel` | `string` | from `~/.seekx/config.yml` | Cross-encoder reranking model. Omit to disable reranking. Example: `BAAI/bge-reranker-v2-m3`. |
| `expandModel` | `string` | from `~/.seekx/config.yml` | LLM used for query expansion. Omit to disable expansion. Example: `Qwen/Qwen3-8B`. |

### Storage

| Field | Type | Default | Description |
|---|---|---|---|
| `dbPath` | `string` | `~/.seekx/openclaw.db` | SQLite database path. Kept separate from the seekx CLI database (`~/.seekx/index.sqlite`) so the two do not interfere. |

### Indexed content

| Field | Type | Default | Description |
|---|---|---|---|
| `includeOpenClawMemory` | `boolean` | `true` | Index OpenClaw's own memory files: `~/.openclaw/workspace/MEMORY.md` and `~/.openclaw/workspace/memory/**/*.md`. Disable only if you manage memory files elsewhere. |
| `paths` | `array` | `[]` | Extra directories to index. Each entry is `{ "name": string, "path": string, "pattern?": string }`. See [Adding extra directories](#adding-extra-directories). |

### Search behavior

| Field | Type | Default | Description |
|---|---|---|---|
| `searchLimit` | `number` | `6` | Maximum number of results returned per `memory_search` call. Higher values give more context at the cost of prompt size. Recommended range: 4–12. |

### Indexing and watching

| Field | Type | Default | Description |
|---|---|---|---|
| `refreshIntervalMs` | `number` | `300000` | Interval between full re-index passes, in milliseconds. The file watcher already handles incremental updates; this is a safety net for missed events. Set to `0` to disable periodic re-indexing. |

---

## Adding extra directories

Index your notes, project documentation, or any directory of Markdown/text
files alongside OpenClaw's built-in memory files.

```json5
{
  "plugins": {
    "entries": {
      "seekx": {
        "enabled": true,
        "config": {
          "paths": [
            { "name": "notes",   "path": "~/notes" },
            { "name": "docs",    "path": "~/projects/docs", "pattern": "**/*.md" },
            { "name": "company", "path": "~/brain/companies" }
          ]
        }
      }
    }
  }
}
```

**`name`** — collection identifier, used in search results and CLI output.
Must be unique across all configured paths.

**`path`** — absolute path or `~/`-prefixed home-relative path. The directory
must exist when the plugin starts, otherwise it is silently skipped.

**`pattern`** — optional glob pattern for which files to index.
Default: `**/*.{md,txt,markdown}`.

Directories are indexed incrementally on startup and watched for changes.
New or modified files are re-indexed within 1–2 seconds of being written.

---

## How the agent uses memory

Once installed, the agent calls `memory_search` automatically before answering
queries that may benefit from stored context. No behavior change is needed.

### Manual search

```
memory_search("kubernetes pod crash loop")
memory_search("Alice's contact info")
memory_search("架构设计决策")
```

### Scoping to a collection

Filter results to a specific directory by name:

```
memory_search("API design", { collection: "docs" })
```

Collection names come from `plugins.entries.seekx.config.paths[].name` in
`~/.openclaw/openclaw.json`. The built-in OpenClaw memory collection is always
named `openclaw-memory`.

Use `openclaw status` to confirm that seekx is active and that aggregate file
and chunk counts are non-zero after indexing.

### Retrieving a full document

Use the `path` field from search results with `memory_get`.
For safety, the plugin only allows reads for files already indexed by seekx:

```
memory_get("/Users/me/notes/people/alice.md")
```

---

## Credential sources and precedence

When multiple credential sources are available, the plugin resolves them in
this order (highest priority first):

1. `plugins.entries.seekx.config` in `~/.openclaw/openclaw.json`
2. `~/.seekx/config.yml` (seekx's own config file)
3. Built-in defaults (empty strings → vector search disabled, BM25 only)

This means you can run seekx CLI and the OpenClaw plugin with the same
credentials without duplicating them: configure once in `~/.seekx/config.yml`,
then set only overrides (if any) in the OpenClaw plugin config.

---

## Database isolation

The plugin stores its index in a **separate** SQLite database
(`~/.seekx/openclaw.db` by default), independent of the seekx CLI database
(`~/.seekx/index.sqlite`). The two processes do not share state and can run
concurrently without conflict.

To change the database path, set `dbPath` in the plugin config:

```json5
{
  "config": {
    "dbPath": "~/.openclaw/seekx.db"
  }
}
```

---

## Degraded modes

The plugin is designed to degrade gracefully at each stage. If a component
is unavailable, the pipeline continues with whatever is available:

| Condition | Behavior |
|---|---|
| No API key or empty `embedModel` | BM25-only search; no vector kNN |
| `sqlite-vec` native library absent | BM25-only search; vector columns exist but are unused |
| `rerankModel` not set | RRF-ranked results used directly; no cross-encoder reranking |
| `expandModel` not set | Only the original query runs; no expanded variants |
| All of the above | Pure BM25 full-text search; still CJK-aware via Jieba |

BM25-only mode works immediately with no API key and is already better than
the trigram-based builtin backend for most queries.

---

## Uninstalling / switching backends

To switch back to the builtin memory backend:

1. Remove or change `plugins.slots.memory` in `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "slots": {
      "memory": "memory-core"   // or remove the slots block entirely
    }
  }
}
```

2. Restart the gateway: `openclaw gateway restart`

The seekx database (`~/.seekx/openclaw.db`) is not deleted automatically.
Remove it manually if you no longer need the indexed content.

To fully uninstall the plugin:

```bash
openclaw plugins uninstall seekx
```

---

## Troubleshooting

### `openclaw status` does not show `plugin seekx` in the Memory row

The `plugins.slots.memory` value must be set to `"seekx"` and the gateway
must be restarted. Check for typos in `openclaw.json` and run
`openclaw plugins list` to confirm the plugin is loaded and enabled.

### No results from `memory_search`

The first search after a gateway restart may take longer because seekx waits
for the startup index pass to finish before returning results. Run
`openclaw status` and inspect the `Memory` row — if `files` and `chunks` are
still 0 after the initial pass completes, check gateway logs for indexing
errors.

### Vector search not available

`openclaw status` shows `plugin seekx · vector off`. This means either no
embedding model is configured, the embedding credentials are missing, or
`sqlite-vec` could not be loaded. On supported platforms (macOS, Linux x64),
seekx attempts to enable vector search automatically when embeddings are
configured.

If you expect vector search, verify:
- `embedModel` is configured
- `baseUrl` and `apiKey` are valid for the chosen provider
- the runtime can load `sqlite-vec`

Vector search is optional; BM25 continues to work regardless.

### Embedding API errors

Gateway logs show connection errors or 401/403 responses. Verify:
- `baseUrl` ends with `/v1` (for OpenAI-compatible endpoints)
- `apiKey` is valid for the chosen provider
- `embedModel` name matches exactly what the provider expects

Check `plugins.entries.seekx.config` in `~/.openclaw/openclaw.json` and
`~/.seekx/config.yml` to confirm which credentials and model names are being
resolved.

### Files in an extra directory are not indexed

- Confirm the directory exists and is readable.
- Check that the file extension matches the configured `pattern`
  (default: `**/*.{md,txt,markdown}`).
- Non-existent directories at plugin startup are silently skipped. Create
  the directory and restart the gateway.

### Memory files changed but search results are stale

The file watcher picks up changes within ~1 second. If results are still
stale, the watcher may have missed an event (common with network drives or
Docker bind mounts). The periodic re-index (`refreshIntervalMs`, default 5 min)
is the safety net in these cases.

---

## Recommended provider configurations

### SiliconFlow (recommended for CJK)

```json5
{
  "baseUrl":     "https://api.siliconflow.cn/v1",
  "embedModel":  "BAAI/bge-large-zh-v1.5",
  "rerankModel": "BAAI/bge-reranker-v2-m3",
  "expandModel": "Qwen/Qwen3-8B"
}
```

### OpenAI

```json5
{
  "baseUrl":     "https://api.openai.com/v1",
  "embedModel":  "text-embedding-3-small",
  "expandModel": "gpt-4o-mini"
}
```

`rerankModel` is not supported on the OpenAI API; omit it to disable reranking.

### Ollama (local, no API key required)

```json5
{
  "baseUrl":    "http://localhost:11434/v1",
  "apiKey":     "ollama",
  "embedModel": "nomic-embed-text"
}
```

Pull the embedding model first: `ollama pull nomic-embed-text`.
Reranking and expansion are optional; omit those fields for a minimal local setup.

---

## Agent-assisted installation

The install skill is self-contained and works **before** the plugin is
installed. Any capable agent with internet or file-system access can run it
— Cursor, Claude Desktop, or OpenClaw's own agent.

### Option A — via URL (agent with web access)

Tell your agent:

```
Fetch and follow this skill:
https://raw.githubusercontent.com/seekx/seekx/main/packages/openclaw-plugin/skills/install/SKILL.md
```

The agent will:
1. Verify OpenClaw is installed
2. Install `@seekx/openclaw`
3. Ask you 4–5 targeted questions to choose a provider and collect your API key
4. Write `~/.openclaw/openclaw.json` with the correct configuration
5. Restart the gateway and confirm the `Memory` row shows `plugin seekx`

### Option B — paste the skill (any agent)

Open the skill file from the seekx repository at
`packages/openclaw-plugin/skills/install/SKILL.md` and paste its contents
into a chat with your agent.

### What the agent asks you

The agent collects only what it needs, in a guided sequence:

1. **Provider** — SiliconFlow / OpenAI / Ollama / custom endpoint
2. **API key** — where to get one is explained per provider
3. **Query expansion** — optional; adds ~50–200 ms per search, improves recall
4. **Extra directories** — optional; any notes or docs folders to index

Everything else (model names, database path, file watcher config) is filled
in automatically using sensible defaults for your chosen provider.
