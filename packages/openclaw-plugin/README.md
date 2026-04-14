# seekx-openclaw

OpenClaw memory backend powered by seekx — local-first hybrid search with BM25, vector kNN, cross-encoder reranking, and CJK support.

[![npm version](https://img.shields.io/npm/v/seekx-openclaw)](https://www.npmjs.com/package/seekx-openclaw)
[![license](https://img.shields.io/github/license/oceanbase/seekx)](../../../LICENSE)

---

## What it does

`seekx-openclaw` replaces OpenClaw's built-in `memory-core` backend with seekx's hybrid search engine. The agent's `memory_search` and `memory_get` tool calls are transparently routed through the seekx pipeline:

```
memory_search("your query")
  │
  ├─ [query expansion]   → 2–3 rephrased variants (optional, LLM)
  │
  ├─ BM25 full-text ─────┐
  └─ vector kNN ─────────┼─ RRF fusion → [cross-encoder rerank] → results
     └─ HyDE pass ───────┘
```

No changes to your agent or prompts are needed. The agent keeps using `memory_search` as before — result quality improves automatically.

### Compared to the built-in backend

| Capability | memory-core | seekx-openclaw |
|---|---|---|
| Full-text search | trigram | BM25 + Jieba (CJK-aware) |
| Semantic / vector search | — | optional, OpenAI-compatible API |
| Cross-encoder reranking | — | optional |
| Query expansion | — | optional (LLM) |
| Extra directories to index | — | unlimited |

All optional stages degrade gracefully: if no API key is configured, seekx runs in BM25-only mode and still outperforms the built-in backend for most queries.

---

## Requirements

| Dependency | Version |
|---|---|
| [OpenClaw](https://openclaw.dev) | ≥ 2026.4.0 |
| Node.js | ≥ 22 LTS |
| Bun (alternative runtime) | ≥ 1.1.0 |

An OpenAI-compatible embedding API is **optional but strongly recommended** for semantic search. Supported providers include SiliconFlow, OpenAI, Jina AI, Ollama, or any OpenAI-compatible endpoint.

---

## Installation

### Option A — Agent-assisted (recommended)

Tell your agent (Cursor, Claude Desktop, or any capable agent with file-system access):

```
Fetch and follow this skill:
https://raw.githubusercontent.com/oceanbase/seekx/main/packages/openclaw-plugin/skills/install/SKILL.md
```

The agent will verify OpenClaw is installed, install the plugin, ask you four targeted questions (provider, API key, query expansion, extra directories), write the config, restart the gateway, and confirm the setup works — all without manual steps.

### Option B — Manual (four steps)

#### Step 1 — Install the plugin package

```bash
openclaw plugins install seekx-openclaw
```

If that command is unavailable (older OpenClaw versions), use the npm fallback:

```bash
npm install -g seekx-openclaw
openclaw plugins install -l "$(npm root -g)/seekx-openclaw"
```

#### Step 2 — Edit `~/.openclaw/openclaw.json`

Add the `plugins` block below. If the file does not exist, create it with `{}` as the starting content.

**Minimal config** — inherits API credentials from `~/.seekx/config.yml` if you already use the seekx CLI:

```json
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

**Standalone config** — include credentials directly (no seekx CLI required):

```json
{
  "plugins": {
    "slots": {
      "memory": "seekx"
    },
    "entries": {
      "seekx": {
        "enabled": true,
        "config": {
          "apiKey":      "sk-xxx",
          "baseUrl":     "https://api.siliconflow.cn/v1",
          "embedModel":  "BAAI/bge-large-zh-v1.5",
          "rerankModel": "BAAI/bge-reranker-v2-m3",
          "expandModel": "Qwen/Qwen3-8B"
        }
      }
    }
  }
}
```

#### Step 3 — Restart the gateway

```bash
openclaw gateway restart
```

#### Step 4 — Verify

```bash
openclaw status
```

The `Memory` row should show `plugin seekx`. If it shows `plugin seekx · vector off`, the plugin is working correctly in BM25-only mode — vector search is inactive because no embedding model is configured or `sqlite-vec` could not load.

---

## Provider configuration examples

### SiliconFlow (recommended for CJK content)

```json
{
  "apiKey":      "sk-xxx",
  "baseUrl":     "https://api.siliconflow.cn/v1",
  "embedModel":  "BAAI/bge-large-zh-v1.5",
  "rerankModel": "BAAI/bge-reranker-v2-m3",
  "expandModel": "Qwen/Qwen3-8B"
}
```

Get a free API key at [cloud.siliconflow.cn](https://cloud.siliconflow.cn).

### OpenAI

```json
{
  "apiKey":      "sk-xxx",
  "baseUrl":     "https://api.openai.com/v1",
  "embedModel":  "text-embedding-3-small",
  "expandModel": "gpt-4o-mini"
}
```

Omit `rerankModel` — OpenAI does not expose a reranking endpoint.

### Ollama (fully local, no API key)

```bash
ollama pull nomic-embed-text   # pull the embedding model first
```

```json
{
  "apiKey":     "ollama",
  "baseUrl":    "http://localhost:11434/v1",
  "embedModel": "nomic-embed-text"
}
```

Omit `rerankModel` and `expandModel` for a minimal local setup, or set `expandModel` to any chat model you have pulled (e.g. `qwen2.5`, `llama3.2`).

---

## Indexing extra directories

Index your own notes, project docs, or any Markdown/text directory alongside OpenClaw's built-in memory files:

```json
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

| Field | Required | Description |
|---|---|---|
| `name` | yes | Collection identifier; appears in search results and `openclaw status`. Must be unique. |
| `path` | yes | Absolute path or `~/`-prefixed home-relative path. Non-existent directories are silently skipped at startup. |
| `pattern` | no | Glob filter. Default: `**/*.{md,txt,markdown}`. |

Files are indexed on startup and watched for changes. Edits are re-indexed within 1–2 seconds.

---

## How the agent uses memory

No changes are needed in your agent prompts. The agent automatically calls `memory_search` before answering queries that may benefit from stored context.

You can also ask explicitly:

```
memory_search("kubernetes pod restart loop")
memory_search("Alice's contact info")
memory_search("架构设计决策")
```

To scope a search to a specific collection:

```
memory_search("API design", { collection: "docs" })
```

Collection names come from `plugins.entries.seekx.config.paths[].name`. The built-in OpenClaw memory files are always available as collection `openclaw-memory`.

To fetch a full document by its path (only paths already indexed by seekx are accessible):

```
memory_get("/Users/me/notes/people/alice.md")
```

---

## Configuration reference

All fields under `plugins.entries.seekx.config` are optional. Fields not provided here inherit from `~/.seekx/config.yml` when that file exists, then fall back to built-in defaults.

### API credentials

| Field | Type | Description |
|---|---|---|
| `apiKey` | `string` | API key for the embedding/reranking/expansion service. |
| `baseUrl` | `string` | OpenAI-compatible base URL, e.g. `https://api.siliconflow.cn/v1`. Must end with `/v1`. |
| `embedModel` | `string` | Embedding model name. Required for vector search. |
| `rerankModel` | `string` | Cross-encoder model name. Omit to disable reranking. |
| `expandModel` | `string` | LLM for query expansion. Omit to disable expansion. |

### Storage

| Field | Type | Default | Description |
|---|---|---|---|
| `dbPath` | `string` | `~/.seekx/openclaw.db` | SQLite database path. Kept separate from the seekx CLI database (`~/.seekx/index.sqlite`). |

### Indexed content

| Field | Type | Default | Description |
|---|---|---|---|
| `includeOpenClawMemory` | `boolean` | `true` | Index `~/.openclaw/workspace/MEMORY.md` and `~/.openclaw/workspace/memory/**/*.md`. |
| `paths` | `array` | `[]` | Extra directories to index. See [Indexing extra directories](#indexing-extra-directories). |

### Search behavior

| Field | Type | Default | Description |
|---|---|---|---|
| `searchLimit` | `number` | `6` | Maximum results per `memory_search` call. Recommended range: 4–12. |

### Watcher and refresh

| Field | Type | Default | Description |
|---|---|---|---|
| `refreshIntervalMs` | `number` | `300000` | Periodic full re-index interval (ms). The file watcher handles incremental updates; this is a safety net for missed events. Set to `0` to disable. |

---

## Degraded modes

The plugin is designed to degrade gracefully. If a component is unavailable, the pipeline continues with what is available:

| Condition | Behavior |
|---|---|
| No `apiKey` or empty `embedModel` | BM25-only mode; no vector search |
| `sqlite-vec` unavailable | BM25-only mode; vector columns exist but are unused |
| `rerankModel` not set | RRF-ranked results are returned directly |
| `expandModel` not set | Only the original query runs; no expanded variants |
| All of the above | Pure BM25 + Jieba; still outperforms trigram-based built-in |

---

## Credential precedence

When the same field is present in multiple places, the plugin resolves it in this order (highest priority first):

1. `plugins.entries.seekx.config` in `~/.openclaw/openclaw.json`
2. `~/.seekx/config.yml` (seekx CLI config)
3. Built-in defaults

You can configure credentials once in `~/.seekx/config.yml` (via `seekx onboard`) and reuse them for the plugin without duplication.

---

## Uninstalling / switching backends

To switch back to the built-in backend, update `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-core"
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

The seekx database (`~/.seekx/openclaw.db`) is not deleted automatically. Remove it manually if you no longer need the indexed content.

To uninstall the plugin package:

```bash
openclaw plugins uninstall seekx
```

---

## Troubleshooting

### `openclaw status` does not show `plugin seekx` in the Memory row

- Confirm `plugins.slots.memory` is set to `"seekx"` (not `"memory-core"` or absent).
- Run `openclaw plugins list` to verify the plugin is listed as enabled.
- Restart the gateway after any config change.

### `memory_search` returns no results right after startup

The first search may block briefly while the initial index pass completes. Run `openclaw status` — if `files` and `chunks` are still `0` after 30 seconds, check gateway logs for indexing errors.

### `plugin seekx · vector off` in `openclaw status`

Valid BM25-only mode. Vector search is inactive because no embedding model is configured, the API credentials are invalid, or `sqlite-vec` could not be loaded. Verify:
- `embedModel` is set
- `baseUrl` ends with `/v1`
- `apiKey` is correct for the chosen provider

### Embedding API errors in gateway logs

- Confirm `baseUrl` ends with `/v1`.
- Confirm the API key matches the provider (SiliconFlow keys start with `sk-`).
- Confirm the model name is spelled exactly as the provider expects (case-sensitive).

### Files in an extra directory are not indexed

- Confirm the directory existed when the gateway started (non-existent paths are silently skipped).
- Confirm file extensions match the configured `pattern` (default: `**/*.{md,txt,markdown}`).
- Restart the gateway after creating a previously missing directory.

### Search results are stale after editing a file

The file watcher picks up changes within ~1 second under normal conditions. Network drives and Docker bind mounts may miss `chokidar` events; the periodic re-index (`refreshIntervalMs`, default 5 min) handles those cases.

---

## Further reading

- [seekx CLI](https://www.npmjs.com/package/seekx) — use seekx as a standalone search tool or MCP server
- [seekx-core](https://www.npmjs.com/package/seekx-core) — the search engine library used by this plugin
- [Full user guide](https://github.com/oceanbase/seekx/blob/main/docs/openclaw-plugin-user-guide.md) — detailed reference with design notes
- [Install skill](./skills/install/SKILL.md) — agent-executable step-by-step install guide
