# Skill: Install seekx memory backend for OpenClaw

> **This skill is self-contained and agent-executable.**
> It can be fetched from a public URL and run by any capable agent
> (Cursor, Claude Desktop, OpenClaw agent, etc.) — even before the plugin
> is installed.
>
> How to invoke: tell your agent:
> "Fetch and follow this skill: https://raw.githubusercontent.com/seekx/seekx/main/packages/openclaw-plugin/skills/install/SKILL.md"

---

## What this skill does

Installs the `@seekx/openclaw` plugin into the user's OpenClaw gateway,
configures an embedding/reranking provider, and verifies the setup end-to-end.

After completion:
- `memory_search` and `memory_get` route through seekx's search pipeline
- OpenClaw's memory files are indexed automatically
- Any extra directories the user specified are indexed and watched
- Vector search, reranking, and query expansion are enabled only when the
  necessary models and runtime support are available; otherwise seekx
  degrades safely to BM25-only mode

---

## Execution steps

Work through the steps below **in order**. At each step, run the command or
collect the answer before proceeding to the next.

---

### Step 1 — Verify OpenClaw is installed

```bash
openclaw --version
```

If the command is not found, tell the user:

> OpenClaw is not installed. Install it first:
> `npm install -g openclaw@latest`
> Then re-run this skill.

Stop here if OpenClaw is not present.

---

### Step 2 — Install the seekx plugin

```bash
openclaw plugins install @seekx/openclaw
```

If this fails with a "not found" error, try the npm fallback:

```bash
npm install -g @seekx/openclaw
```

Then register it as a local plugin:

```bash
openclaw plugins install -l "$(npm root -g)/@seekx/openclaw"
```

Confirm it loaded:

```bash
openclaw plugins list | grep seekx
```

---

### Step 3 — Choose a provider (guided)

Ask the user the following questions **one at a time, in order**.
Collect all answers before writing any config.

---

#### Question A — API key source

> Do you have an API key from a cloud provider, or do you prefer to run
> everything locally with Ollama?

Offer these options:

| Option | When to choose |
|---|---|
| **SiliconFlow** | Best for Chinese/Japanese/Korean text; supports reranking; low cost; requires a free account at siliconflow.cn |
| **OpenAI** | Best for English; widely used; does not support reranking via this plugin |
| **Ollama** | Fully local, no API key, no internet required; pull models first |
| **Other / Custom** | You have an OpenAI-compatible endpoint (Jina, Together, Groq, self-hosted, etc.) |

Record the user's choice as `PROVIDER`.

---

#### Question B — API key (skip if Ollama)

If `PROVIDER` is **SiliconFlow**:

> Please provide your SiliconFlow API key.
> (Get one free at https://cloud.siliconflow.cn — click "API Keys" after signing in.)

If `PROVIDER` is **OpenAI**:

> Please provide your OpenAI API key.
> (Find it at https://platform.openai.com/api-keys)

If `PROVIDER` is **Other / Custom**:

> Please provide:
> 1. Your API base URL (must end with `/v1`, e.g. `https://api.example.com/v1`)
> 2. Your API key

Record as `API_KEY` and `BASE_URL`.

If `PROVIDER` is **Ollama**:
- Set `API_KEY = "ollama"` (placeholder, Ollama ignores it)
- Set `BASE_URL = "http://localhost:11434/v1"`
- Tell the user to pull the embedding model first:
  ```bash
  ollama pull nomic-embed-text
  ```

---

#### Question C — Enable query expansion? (optional)

> seekx can generate 2–3 variant phrasings of your query before searching,
> which improves recall — especially for vague or short queries.
>
> This uses one extra LLM call per search (~50–200 ms extra latency).
>
> Would you like to enable query expansion? (Recommended: yes)

If yes, record `EXPAND_MODEL` using this table:

| Provider | Recommended expand model |
|---|---|
| SiliconFlow | `Qwen/Qwen3-8B` |
| OpenAI | `gpt-4o-mini` |
| Ollama | Any chat model the user has pulled (e.g. `llama3.2`, `qwen2.5`) |
| Custom | Ask the user for a model name |

If no, set `EXPAND_MODEL = null`.

---

#### Question D — Extra directories (optional)

> Would you like to index any of your own directories (notes, docs, etc.)
> in addition to OpenClaw's built-in memory files?
>
> If yes, list them. For each, provide:
> - A short name (e.g. `notes`, `docs`, `brain`)
> - The full path (e.g. `~/notes` or `/Users/me/Documents/notes`)

Collect as a list of `{ name, path }` pairs.
If the user says no or skips, use an empty list.

---

### Step 4 — Build the configuration

Using the answers collected above, assemble the `pluginConfig` object.

**For SiliconFlow:**

```json
{
  "apiKey":       "<API_KEY>",
  "baseUrl":      "https://api.siliconflow.cn/v1",
  "embedModel":   "BAAI/bge-large-zh-v1.5",
  "rerankModel":  "BAAI/bge-reranker-v2-m3",
  "expandModel":  "<EXPAND_MODEL or omit>",
  "paths":        []
}
```

**For OpenAI:**

```json
{
  "apiKey":      "<API_KEY>",
  "baseUrl":     "https://api.openai.com/v1",
  "embedModel":  "text-embedding-3-small",
  "expandModel": "<EXPAND_MODEL or omit>",
  "paths":       []
}
```

(Omit `rerankModel` — OpenAI does not expose a reranking endpoint.)

**For Ollama:**

```json
{
  "apiKey":     "ollama",
  "baseUrl":    "http://localhost:11434/v1",
  "embedModel": "nomic-embed-text",
  "expandModel": "<EXPAND_MODEL or omit>",
  "paths":      []
}
```

**For Custom:**

```json
{
  "apiKey":      "<API_KEY>",
  "baseUrl":     "<BASE_URL>",
  "embedModel":  "<ask user>",
  "rerankModel": "<ask user, or omit>",
  "expandModel": "<EXPAND_MODEL or omit>",
  "paths":       []
}
```

If the user provided extra directories, populate `paths`:

```json
"paths": [
  { "name": "notes", "path": "~/notes" },
  { "name": "docs",  "path": "~/projects/docs" }
]
```

---

### Step 5 — Write the OpenClaw config

Read the current config file:

```bash
cat ~/.openclaw/openclaw.json
```

If the file does not exist, start with `{}`.

Merge the following into the config (do not overwrite unrelated fields):

```json5
{
  "plugins": {
    "slots": {
      "memory": "seekx"          // makes seekx the exclusive memory backend
    },
    "entries": {
      "seekx": {
        "enabled": true,
        "config": {
          // paste the pluginConfig object assembled in Step 4
        }
      }
    }
  }
}
```

Write the merged result back to `~/.openclaw/openclaw.json`.

After writing, validate the file is parseable:

```bash
node -e "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8'))" \
  && echo "valid JSON" || echo "PARSE ERROR — do not restart yet"
```

Stop and show the error if parsing fails.

---

### Step 6 — Restart the gateway

```bash
openclaw gateway restart
```

Wait 3 seconds, then check that the gateway is running:

```bash
openclaw gateway status
```

---

### Step 7 — Verify

```bash
openclaw status
```

Confirm the `Memory` row contains `plugin seekx`.

Interpret the row as follows:
- `N files · N chunks · plugin seekx` → installation and indexing are working
- `0 files · 0 chunks · plugin seekx` right after restart → the initial index
  may still be warming up; wait 15 seconds and run `openclaw status` again
- `plugin seekx · vector off` → valid BM25-only mode; vector search is not
  active because no embedding model is configured or `sqlite-vec` is unavailable

If the user already has memory files and an active OpenClaw agent session,
optionally ask a memory-backed question through the agent to confirm end-to-end
retrieval. Do not instruct the user to run `openclaw memory ...`; current
OpenClaw versions expose memory backend state through `openclaw status`.

---

### Step 8 — Report to the user

Tell the user:

> seekx is now your OpenClaw memory backend.
>
> - OpenClaw's memory files (`MEMORY.md`, `memory/**/*.md`) are indexed automatically.
> - [If extra directories were configured] Your extra directories are indexed and watched for changes.
> - `memory_search` and `memory_get` now use seekx's search pipeline: BM25 by default, plus vector/rerank/expansion when configured and available.
>
> To check status at any time: `openclaw status`
> To add more directories later: edit `~/.openclaw/openclaw.json` → `plugins.entries.seekx.config.paths`

---

## Troubleshooting

**`openclaw plugins install` hangs or fails**
→ Try `openclaw plugins install @seekx/openclaw --force`
→ Or use the npm fallback path in Step 2.

**`openclaw status` does not show `plugin seekx` in the Memory row**
→ Check that `plugins.slots.memory` is `"seekx"` (not `"memory-core"` or missing).
→ Run `openclaw plugins list` and confirm seekx is listed as enabled.

**Status shows `plugin seekx · vector off`**
→ This is expected when no embedding model is configured, the API credentials are missing, or `sqlite-vec` cannot load.
→ BM25 search still works; seekx is installed correctly.

**API key error / 401 from provider**
→ Double-check the key and baseUrl.
→ For SiliconFlow: the key starts with `sk-` and was copied from the API Keys page.
→ Re-run Step 5 with corrected values and restart the gateway.
