# seekx OpenClaw Plugin — Design Document

## Overview

This document is a complete, self-contained implementation specification for
`packages/openclaw-plugin`, a new package in the seekx monorepo that integrates
seekx into [OpenClaw](https://openclaw.ai) as its primary **memory backend**.

Once installed, users' `memory_search` and `memory_get` calls are transparently
routed through seekx's hybrid search pipeline (BM25 + vector + RRF + rerank +
query expansion). The agent requires no behavior changes — tool names stay the
same, quality improves.

### Why this design

OpenClaw has three built-in memory backends: builtin (SQLite), QMD (local GGUF
sidecar), and Honcho (cloud). seekx's positioning is closest to QMD: local-first
file indexing with hybrid search. However, seekx is implemented as an OpenClaw
TypeScript plugin (using `api.registerMemoryRuntime`) rather than a subprocess
binary, giving it tighter integration and no external process to manage.

**Advantages over OpenClaw builtin:**
- Query expansion and cross-encoder reranking (builtin has neither)
- CJK support via Jieba tokenizer (builtin uses trigram, inferior for Chinese)

**Advantages over QMD:**
- No ~2 GB GGUF model download; uses OpenAI-compatible API for embed/rerank
- Pure SQLite, no native build dependencies (`node-llama-cpp`, etc.)
- Compatible with SiliconFlow, Jina, Ollama, and any OpenAI-compatible endpoint

---

## Repository context

The seekx monorepo uses **Bun** + **TypeScript workspaces**. The two existing
packages are:

```
packages/
  core/     — seekx-core: engine library (SQLite, search, indexer, watcher)
  cli/      — seekx: CLI + MCP server; depends on seekx-core
```

The new package goes in `packages/openclaw-plugin/`.

### seekx-core public API used by the plugin

All of these are exported from `seekx-core` (`packages/core/src/index.ts`):

```typescript
// Database lifecycle
openDatabase(path: string): Database
loadSqliteVec(db: Database): Promise<boolean>   // returns false, never throws
Store(db: Database, vecLoaded: boolean)          // constructor

// Store CRUD used by the plugin
store.addCollection(input: AddCollectionInput): void
  // AddCollectionInput: { name, path, pattern?, ignore?, description? }
store.listCollections(): CollectionRow[]
  // CollectionRow: { name, path, pattern, ignore_json, created_at }
store.getStatus(): IndexStatus
  // IndexStatus: { sqliteVecLoaded, vectorSearchAvailable, embedModel,
  //               embedDim, totalDocuments, totalChunks, embeddedChunks,
  //               collections: [{name,path,docCount,chunkCount,lastIndexed}] }
store.collectionStats(name: string): CollectionStats
  // CollectionStats: { docCount, chunkCount }
store.close(): void

// Search
hybridSearch(
  store: Store,
  client: SeekxClient | null,
  query: string,
  opts?: SearchOptions,
): Promise<{ results: SearchResult[]; expandedQueries: string[]; warnings: string[] }>

// SearchOptions relevant to the plugin:
interface SearchOptions {
  collections?: string[];   // restrict to named collections
  limit?: number;           // default 10
  minScore?: number;        // vector similarity threshold (0–1)
  minResultScore?: number;  // normalized score threshold (0–1)
  mode?: "hybrid" | "bm25" | "vector";
  useRerank?: boolean;
  useExpand?: boolean;
  useHyde?: boolean;
}

// SearchResult (returned by hybridSearch):
interface SearchResult {
  docid: string;            // short hex id
  chunk_id: number;
  file: string;             // absolute filesystem path
  title: string | null;
  collection: string;
  score: number;            // 0–1
  snippet: string;          // relevant text excerpt
  start_line: number;
  end_line: number;
  expandedQueries?: string[];
}

// Indexing
indexDirectory(
  store: Store,
  client: SeekxClient | null,
  rootPath: string,
  collection: string,
  opts?: { pattern?: string; ignore?: string[]; onProgress?: IndexProgressCallback },
): Promise<IndexDirectoryResult>
// IndexDirectoryResult: { indexed, skipped, errors, totalFiles }

// File watching
Watcher(
  store: Store,
  client: SeekxClient | null,
  collections: CollectionWatch[],   // [{ collection: string, rootPath: string }]
  opts?: WatchOptions,              // { debounceMs?, ignore?, syncIntervalMs? }
): Watcher (extends EventEmitter)
watcher.start(): void
watcher.stop(): Promise<void>

// Client
SeekxClient(
  embed_cfg: ServiceEndpoint,       // { baseUrl, apiKey, model }
  rerank_cfg: ServiceEndpoint | null,
  expand_cfg: ServiceEndpoint | null,
  cache?: LLMCache,                 // { get(key), set(key, value, ttlSec?) }
)
client.embed(texts: string[]): Promise<number[][] | null>
client.healthCheck(): Promise<{ embed, rerank, expand }>

// Config
loadConfig(): ResolvedConfig | null
isEmbedConfigured(cfg: ResolvedConfig): boolean
// ResolvedConfig: { embed, rerank, expand, search, watch, dbPath, configPath }
// ServiceEndpoint: { baseUrl, apiKey, model }
```

### How the CLI initializes (reference pattern)

```typescript
// From packages/cli/src/utils.ts — openContext():
const cfg = requireConfig();                        // reads ~/.seekx/config.yml
const db = openDatabase(cfg.dbPath);                // opens ~/.seekx/index.sqlite
const vecLoaded = await loadSqliteVec(db);
const store = new Store(db, vecLoaded);
const llmCache = {
  get: (key) => store.getCachedLLM(key),
  set: (key, value, ttlSec?) => store.setCachedLLM(key, value, ttlSec),
};
const client = isEmbedConfigured(cfg)
  ? new SeekxClient(cfg.embed, cfg.rerank, cfg.expand, llmCache)
  : null;
```

The plugin follows the same initialization pattern but reads config from both
`~/.seekx/config.yml` (seekx's own config) and from OpenClaw's plugin config
(for extra paths and optional overrides).

---

## New package: `packages/openclaw-plugin`

### File structure

```
packages/openclaw-plugin/
├── package.json
├── tsconfig.json
├── openclaw.plugin.json
├── src/
│   ├── index.ts          Plugin entry point: definePluginEntry + register()
│   ├── runtime.ts        MemorySearchManager implementation
│   ├── lifecycle.ts      SeekxLifecycle: db, watcher, periodic refresh
│   └── config.ts         Plugin config parsing + seekx config bridge
└── skills/
    ├── install/
    │   └── SKILL.md      Agent-executable install + config skill
    └── search/
        └── SKILL.md      Teaches agent when to call memory_search
```

### `package.json`

```json
{
  "name": "seekx-openclaw",
  "version": "0.1.0",
  "description": "OpenClaw memory backend: hybrid BM25 + vector search with reranking and CJK support",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "skills", "openclaw.plugin.json"],
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "install": { "minHostVersion": ">=2026.4.0" }
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test test/"
  },
  "dependencies": {
    "seekx-core": "^0.2.2"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.8.3"
  },
  "engines": { "bun": ">=1.1.0" }
}
```

> `seekx-core` is a workspace reference so the plugin always uses the local
> version during development and a pinned npm version in production.

### `tsconfig.json`

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

### `openclaw.plugin.json`

```json
{
  "name": "seekx",
  "version": "0.1.0",
  "description": "Local-first hybrid search memory backend: BM25 + vector + rerank + CJK",
  "kind": "memory",
  "configSchema": {
    "dbPath": {
      "type": "string",
      "required": false,
      "description": "SQLite database path. Defaults to ~/.seekx/openclaw.db"
    },
    "paths": {
      "type": "array",
      "required": false,
      "description": "Extra directories to index: [{name, path, pattern?}]"
    },
    "apiKey": {
      "type": "string",
      "required": false,
      "uiHints": { "sensitive": true },
      "description": "API key for embedding/reranking. Inherits from ~/.seekx/config.yml if unset."
    },
    "baseUrl": {
      "type": "string",
      "required": false,
      "description": "OpenAI-compatible API base URL. Inherits from ~/.seekx/config.yml if unset."
    },
    "embedModel": {
      "type": "string",
      "required": false,
      "description": "Embedding model name."
    },
    "rerankModel": {
      "type": "string",
      "required": false,
      "description": "Reranking model name. Omit to disable reranking."
    },
    "expandModel": {
      "type": "string",
      "required": false,
      "description": "Query expansion model name. Omit to disable expansion."
    },
    "searchLimit": {
      "type": "number",
      "required": false,
      "description": "Max results per memory_search call. Default: 6."
    },
    "refreshIntervalMs": {
      "type": "number",
      "required": false,
      "description": "Periodic re-index interval in ms. Default: 300000 (5 min)."
    },
    "includeOpenClawMemory": {
      "type": "boolean",
      "required": false,
      "description": "Auto-index ~/.openclaw/workspace/MEMORY.md and memory/**/*.md. Default: true."
    }
  },
  "openclaw": {
    "compat": { "pluginApi": ">=2026.4.0" }
  }
}
```

---

## Implementation

### `src/config.ts`

Responsibility: merge OpenClaw plugin config with seekx's own config file.

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ResolvedConfig, type ServiceEndpoint } from "seekx-core";

export interface ExtraPath {
  name: string;
  path: string;
  pattern?: string;
}

/** Raw shape of what OpenClaw puts in pluginConfig. */
export interface RawPluginConfig {
  dbPath?: string;
  paths?: ExtraPath[];
  apiKey?: string;
  baseUrl?: string;
  embedModel?: string;
  rerankModel?: string;
  expandModel?: string;
  searchLimit?: number;
  refreshIntervalMs?: number;
  includeOpenClawMemory?: boolean;
}

export interface SeekxPluginConfig {
  dbPath: string;
  extraPaths: ExtraPath[];
  embed: ServiceEndpoint;
  rerank: ServiceEndpoint | null;
  expand: ServiceEndpoint | null;
  searchLimit: number;
  refreshIntervalMs: number;
  includeOpenClawMemory: boolean;
}

/**
 * Merge the OpenClaw plugin config with the seekx config file.
 * Plugin config fields override the seekx config file values.
 * Precedence (high → low):
 *   1. pluginConfig fields (set by user in openclaw.json)
 *   2. ~/.seekx/config.yml (seekx's own config)
 *   3. built-in defaults
 */
export function resolvePluginConfig(raw: RawPluginConfig): SeekxPluginConfig {
  // Load base config from ~/.seekx/config.yml if it exists.
  const base: ResolvedConfig | null = loadConfig();

  const baseUrl = raw.baseUrl ?? base?.embed.baseUrl ?? "";
  const apiKey = raw.apiKey ?? base?.embed.apiKey ?? "";
  const embedModel = raw.embedModel ?? base?.embed.model ?? "";
  const rerankModel = raw.rerankModel ?? base?.rerank?.model ?? null;
  const expandModel = raw.expandModel ?? base?.expand?.model ?? null;

  const embed: ServiceEndpoint = { baseUrl, apiKey, model: embedModel };

  const rerank: ServiceEndpoint | null =
    rerankModel ? { baseUrl, apiKey, model: rerankModel } : (base?.rerank ?? null);

  const expand: ServiceEndpoint | null =
    expandModel ? { baseUrl, apiKey, model: expandModel } : (base?.expand ?? null);

  return {
    dbPath: raw.dbPath ?? join(homedir(), ".seekx", "openclaw.db"),
    extraPaths: raw.paths ?? [],
    embed,
    rerank,
    expand,
    searchLimit: raw.searchLimit ?? 6,
    refreshIntervalMs: raw.refreshIntervalMs ?? 300_000,
    includeOpenClawMemory: raw.includeOpenClawMemory ?? true,
  };
}
```

---

### `src/lifecycle.ts`

Responsibility: own the database, client, indexing, and file watcher lifetime.
The plugin entry creates one `SeekxLifecycle` instance and passes it to the
runtime.

```typescript
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import {
  openDatabase,
  loadSqliteVec,
  Store,
  SeekxClient,
  Watcher,
  indexDirectory,
  type Database,
  type CollectionWatch,
} from "seekx-core";
import { type SeekxPluginConfig } from "./config.ts";

/** Name for the collection that tracks OpenClaw's own memory files. */
const OPENCLAW_MEMORY_COLLECTION = "openclaw-memory";

/** Resolved absolute path to OpenClaw's workspace memory directory. */
function openClawMemoryPath(): string {
  return join(homedir(), ".openclaw", "workspace");
}

export class SeekxLifecycle {
  readonly config: SeekxPluginConfig;
  db!: Database;
  store!: Store;
  client: SeekxClient | null = null;
  private watcher: Watcher | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(config: SeekxPluginConfig) {
    this.config = config;
  }

  /**
   * Open the database, register collections, run initial indexing, and start
   * the file watcher. Safe to call multiple times (idempotent after first call).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Ensure DB directory exists.
    const dbDir = dirname(this.config.dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    this.db = openDatabase(this.config.dbPath);
    const vecLoaded = await loadSqliteVec(this.db);
    this.store = new Store(this.db, vecLoaded);

    // Wire the store's LLM cache into the client (same pattern as CLI).
    const llmCache = {
      get: (key: string) => this.store.getCachedLLM(key),
      set: (key: string, value: string, ttlSec?: number) =>
        this.store.setCachedLLM(key, value, ttlSec),
    };

    const { embed, rerank, expand } = this.config;
    this.client =
      embed.baseUrl && embed.model
        ? new SeekxClient(embed, rerank, expand, llmCache)
        : null;

    // Register OpenClaw's own memory files as a collection.
    if (this.config.includeOpenClawMemory) {
      const memPath = openClawMemoryPath();
      if (existsSync(memPath)) {
        this.store.addCollection({
          name: OPENCLAW_MEMORY_COLLECTION,
          path: memPath,
          // Index MEMORY.md and all daily note files.
          pattern: "**/*.md",
        });
      }
    }

    // Register user-configured extra paths.
    for (const ep of this.config.extraPaths) {
      const absPath = ep.path.replace(/^~/, homedir());
      if (!existsSync(absPath)) continue;
      this.store.addCollection({
        name: ep.name,
        path: absPath,
        ...(ep.pattern ? { pattern: ep.pattern } : {}),
      });
    }

    // Initial indexing: runs in background, does not block plugin startup.
    void this._runFullIndex();

    // File watcher: listens for changes across all registered collections.
    // syncIntervalMs=30000 makes watcher self-heal if a collection is added
    // via `seekx add` in another process.
    const collectionWatches: CollectionWatch[] = this.store
      .listCollections()
      .map((c) => ({ collection: c.name, rootPath: c.path }));

    this.watcher = new Watcher(this.store, this.client, collectionWatches, {
      debounceMs: 1000,
      syncIntervalMs: 30_000,
    });
    this.watcher.start();

    // Periodic full re-index (safety net for missed watcher events).
    if (this.config.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(
        () => void this._runFullIndex(),
        this.config.refreshIntervalMs,
      );
    }
  }

  /** Run incremental indexing across all registered collections. */
  private async _runFullIndex(): Promise<void> {
    const collections = this.store.listCollections();
    for (const col of collections) {
      try {
        await indexDirectory(this.store, this.client, col.path, col.name, {
          pattern: col.pattern,
          ignore: col.ignore_json ? (JSON.parse(col.ignore_json) as string[]) : undefined,
        });
      } catch (err) {
        console.error(`[seekx-openclaw] indexDirectory error for "${col.name}": ${err}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.watcher?.stop();
    this.store?.close();
  }
}
```

---

### `src/runtime.ts`

Responsibility: implement OpenClaw's `MemorySearchManager` interface using
seekx-core's `hybridSearch` and filesystem reads.

```typescript
import { readFileSync } from "node:fs";
import { hybridSearch } from "seekx-core";
import type { SeekxLifecycle } from "./lifecycle.ts";

// ---------------------------------------------------------------------------
// OpenClaw MemorySearchManager interface
// (inferred from openclaw SDK / Honcho plugin source)
// ---------------------------------------------------------------------------

export interface MemorySearchResult {
  path: string;       // absolute file path (shown as Source: citation)
  content: string;    // text snippet injected into the prompt
  score: number;      // 0–1 relevance score
  collection: string; // collection name (seekx collection)
}

export interface MemorySearchOpts {
  limit?: number;
}

export interface BackendStatus {
  backend: string;
  provider?: string;
  dbPath?: string;
  files?: number;
  chunks?: number;
  documents?: number;
  embeddedChunks?: number;
  vectorSearchAvailable?: boolean;
  embedModel?: string | null;
  collections?: Array<{ name: string; path: string; docCount: number }>;
  vector?: { enabled: boolean; available?: boolean };
  custom?: Record<string, unknown>;
}

export interface MemorySearchManager {
  search(query: string, opts: MemorySearchOpts): Promise<MemorySearchResult[]>;
  readFile(path: string): Promise<string>;
  status(): BackendStatus;
  probeEmbeddingAvailability(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the MemorySearchManager that OpenClaw's runtime calls.
 * Called once by the plugin entry; lc must already be .start()-ed.
 */
export function buildMemorySearchManager(lc: SeekxLifecycle): { manager: MemorySearchManager } {
  const manager: MemorySearchManager = {
    /**
     * memory_search implementation.
     * Routes through seekx's full hybrid pipeline:
     *   query expansion → BM25 + vector kNN → RRF → cross-encoder rerank
     * All stages degrade gracefully when unavailable.
     */
    async search(query, opts) {
      await lc.waitForSearchReady();
      const limit = opts.limit ?? lc.config.searchLimit;
      const { results } = await hybridSearch(lc.store, lc.client, query, {
        limit,
        mode: "hybrid",
        useExpand: lc.config.expand !== null,
        useRerank: lc.config.rerank !== null,
        minResultScore: 0.01,
      });

      return results.map((r) => ({
        path: r.file,
        content: r.snippet,
        score: r.score,
        collection: r.collection,
      }));
    },

    /**
     * memory_get implementation.
     * Returns the live file content when the path is inside an indexed
     * collection. Falls back to an empty string for deleted files or paths
     * outside indexed scope.
     */
    async readFile(path) {
      const readablePath = await lc.resolveReadablePath(path);
      if (!readablePath) return "";
      try {
        return readFileSync(readablePath, "utf-8");
      } catch {
        return "";
      }
    },

    status() {
      const s = lc.store?.getStatus() ?? readPersistedSeekxStatusSync(lc.config.dbPath);
      if (!s) {
        return {
          backend: "seekx",
          provider: "seekx",
          dbPath: lc.config.dbPath,
          files: 0,
          chunks: 0,
        };
      }
      return {
        backend: "seekx",
        provider: "seekx",
        dbPath: lc.config.dbPath,
        files: s.totalDocuments,
        chunks: s.totalChunks,
        vector: {
          enabled: s.vectorSearchAvailable,
          available: s.vectorSearchAvailable,
        },
        custom: {
          embeddedChunks: s.embeddedChunks,
          embedModel: s.embedModel,
          collections: s.collections.map((c) => ({
            name: c.name,
            path: c.path,
            docCount: c.docCount,
          })),
        },
      };
    },

    async probeEmbeddingAvailability() {
      if (!lc.client) return false;
      const cfg = lc.config.embed;
      return Boolean(cfg.baseUrl && cfg.model && cfg.apiKey);
    },

    async probeVectorAvailability() {
      return (
        lc.store?.getStatus().vectorSearchAvailable ??
        readPersistedSeekxStatusSync(lc.config.dbPath)?.vectorSearchAvailable ??
        false
      );
    },
  };

  return { manager };
}
```

---

### `src/index.ts`

Responsibility: plugin entry point. Wires lifecycle and runtime into OpenClaw's
API.

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePluginConfig, type RawPluginConfig } from "./config.ts";
import { SeekxLifecycle } from "./lifecycle.ts";
import { buildMemorySearchManager } from "./runtime.ts";

export default definePluginEntry({
  id: "seekx",
  register(api) {
    const raw = (api.pluginConfig ?? {}) as RawPluginConfig;
    const config = resolvePluginConfig(raw);
    const lifecycle = new SeekxLifecycle(config);

    // Start lifecycle eagerly so the initial index is ready before the first
    // memory_search call. start() is non-blocking; indexing continues in the
    // background.
    void lifecycle.start();

    api.registerMemoryRuntime({
      getMemorySearchManager: () => buildMemorySearchManager(lifecycle),
      resolveMemoryBackendConfig: (rawCfg: unknown) =>
        resolvePluginConfig(rawCfg as RawPluginConfig),
    });

    api.registerService({
      id: "seekx-lifecycle",
      stop: () => lifecycle.stop(),
    });
  },
});
```

---

## Skill files

### `skills/install/SKILL.md`

```markdown
# seekx memory backend — install

seekx replaces OpenClaw's memory backend with a search pipeline that always
supports BM25 and optionally enables vector similarity, reranking, and query
expansion when configured.
Supports CJK (Chinese/Japanese/Korean) via Jieba tokenizer.
Requires an OpenAI-compatible API (SiliconFlow, Jina, Ollama, OpenAI).

## Step 1 — Install seekx globally

  npm install -g seekx-openclaw
  # or: bun add -g seekx-openclaw

Verify: seekx-openclaw --version

## Step 2 — Configure OpenClaw

Add the seekx plugin to ~/.openclaw/openclaw.json:

  {
    "plugins": {
      "entries": {
        "seekx": {
          "enabled": true,
          "config": {
            "apiKey": "<ask user for API key>",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "embedModel": "BAAI/bge-large-zh-v1.5",
            "rerankModel": "BAAI/bge-reranker-v2-m3",
            "expandModel": "Qwen/Qwen3-8B",
            "paths": []
          }
        }
      }
    }
  }

Ask the user for:
  - API key for the chosen provider
  - API base URL (default: SiliconFlow; OpenAI: https://api.openai.com/v1)
  - Embedding model, reranking model, query expansion model

If the user already has ~/.seekx/config.yml configured, apiKey and baseUrl
can be omitted from pluginConfig — the plugin inherits them automatically.

## Step 3 — Add extra directories (optional)

To index the user's notes or docs alongside OpenClaw's memory files,
add them to the paths array:

  "paths": [
    { "name": "notes", "path": "~/notes" },
    { "name": "docs",  "path": "~/projects/docs" }
  ]

Ask the user which directories they want indexed.

## Step 4 — Restart OpenClaw and verify

  openclaw status

Expected output includes a `Memory` row containing `plugin seekx`.
`vector off` is valid and indicates BM25-only mode.

## Done

memory_search and memory_get now run through seekx's search pipeline.
OpenClaw's memory files (MEMORY.md, memory/**/*.md) are indexed automatically.
Extra directories are indexed incrementally and watched for changes.
```

### `skills/search/SKILL.md`

```markdown
# seekx memory search — usage

seekx is installed as the OpenClaw memory backend.
memory_search now uses seekx's search pipeline: BM25 by default, with vector,
reranking, and query expansion enabled when available.

## When to search

Search before responding to any query that might be answered by stored knowledge:
  - Questions about people, companies, projects, or past decisions
  - Technical questions about indexed codebases or documentation
  - Any query where local context could improve the answer

## How to search

Use the standard memory_search tool. seekx handles the rest:

  memory_search("kubernetes pod crash loop")
  → query expansion may run when configured
  → BM25 search always runs
  → vector search may join when embeddings are available
  → cross-encoder reranking may run when configured
  → top results injected into context

## Scoping to a collection

If you know the relevant directory, pass it as a filter:

  memory_search("架构设计", { collection: "docs" })

Collection names come from `paths[].name` in plugin config. The built-in
OpenClaw memory collection is named `openclaw-memory`.

## Retrieving a full document

Use memory_get with the path returned in search results:

  memory_get("/Users/me/notes/people/alice.md")

Paths outside indexed collections resolve to an empty string.
```

---

## Data flow (runtime)

```
User sends message
       │
       ▼
OpenClaw fires memory_search("query", { limit: 6 })
       │
       ▼
seekx MemorySearchManager.search("query", { limit: 6 })
       │
       ├─ hybridSearch(store, client, "query", { useExpand: true, useRerank: true })
       │      │
       │      ├─ [1] client.expand("query") → ["q1", "q2", "q3"]
       │      ├─ [2] store.searchFTS(q1..q3) → BM25 ranked lists
       │      ├─ [3] client.embed(q1..q3) → store.searchVector() → kNN lists
       │      ├─ [4] RRF fusion → merged candidate list
       │      └─ [5] client.rerank(query, candidates) → final ranked list
       │
       ▼
MemorySearchResult[] → OpenClaw injects snippets into system prompt
       │
       ▼
LLM sees: [context from seekx] + user message → generates response
```

All stages degrade gracefully: if embed is unavailable, step 3 is skipped
(BM25 only). If rerank is unavailable, step 5 is skipped (RRF order used).
If expand is unavailable, only the original query runs in steps 2 and 3.

---

## Lifecycle timeline

```
Plugin load:
  resolvePluginConfig(api.pluginConfig)     ← merge plugin config + ~/.seekx/config.yml
  SeekxLifecycle.start()                    ← non-blocking
    openDatabase(dbPath)                    ← opens ~/.seekx/openclaw.db
    loadSqliteVec(db)                       ← loads sqlite-vec (optional)
    new Store(db, vecLoaded)
    new SeekxClient(embed, rerank, expand)
    store.addCollection("openclaw-memory")  ← ~/.openclaw/workspace/
    store.addCollection("notes")            ← ~/notes/ (if configured)
    indexDirectory(all collections)         ← incremental, background
    new Watcher(store, client, [...])       ← chokidar file watcher
    watcher.start()
    setInterval(indexDirectory, 5min)       ← periodic safety net

Per memory_search call:
  hybridSearch(store, client, query, opts)  ← ~50–300ms typical

File change (watcher event):
  indexFile(store, client, collection, path)  ← mtime+hash diff, incremental

OpenClaw exits:
  watcher.stop()
  store.close()
```

---

## Changes required in `seekx-core`

After reading the current `store.ts`, two small additions are needed:

### 1. `Store.getCachedLLM` and `Store.setCachedLLM` — verify they are public

These are required by the plugin's `llmCache` wiring (same pattern as the CLI).
Confirm both are public methods in `store.ts`. They are present in the current
codebase (`getCachedLLM`, `setCachedLLM`, `evictExpiredLLMCache`).

### 2. No other additions needed

The plugin uses only public API already exported from `seekx-core/src/index.ts`:
`openDatabase`, `loadSqliteVec`, `Store`, `SeekxClient`, `hybridSearch`,
`indexDirectory`, `Watcher`, `loadConfig`, `isEmbedConfigured`.

`readFile` in the runtime reads directly from the filesystem via `node:fs`,
not through the store, so no new store method is required.

---

## Testing

### Unit tests — `test/config.test.ts`

Test `resolvePluginConfig` with various combinations of:
- Only plugin config (no seekx config file)
- Only seekx config file (no plugin config overrides)
- Both: verify plugin config fields override seekx config file values
- Missing required fields: verify graceful degradation (client = null)

### Integration test — `test/lifecycle.test.ts`

Using a temp directory:
1. Create two markdown files
2. `lifecycle.start()` → `indexDirectory` should index both
3. `hybridSearch` should return results for a relevant query
4. Modify one file → watcher should re-index it within debounce time
5. `lifecycle.stop()` → clean shutdown

### Manual smoke test

```bash
# In the monorepo root
bun install
cd packages/openclaw-plugin

# Configure a seekx config first (or set plugin config inline)
cat ~/.seekx/config.yml   # verify embed/rerank/expand are set

# Run the plugin as a standalone check (if we add a test-runner script)
bun run src/index.ts

# Or: configure OpenClaw, restart, then:
openclaw status           # Memory row should show plugin seekx
```

---

## User experience summary

### Minimal setup (inherits from `~/.seekx/config.yml`)

```json
{
  "plugins": {
    "entries": {
      "seekx": { "enabled": true }
    }
  }
}
```

Indexes: `MEMORY.md` + `memory/**/*.md` only.
Config: reads API keys and models from existing `~/.seekx/config.yml`.

### Full setup with extra directories

```json
{
  "plugins": {
    "entries": {
      "seekx": {
        "enabled": true,
        "config": {
          "apiKey": "sk-xxx",
          "baseUrl": "https://api.siliconflow.cn/v1",
          "embedModel": "BAAI/bge-large-zh-v1.5",
          "rerankModel": "BAAI/bge-reranker-v2-m3",
          "expandModel": "Qwen/Qwen3-8B",
          "searchLimit": 6,
          "includeOpenClawMemory": true,
          "paths": [
            { "name": "notes",   "path": "~/notes"           },
            { "name": "docs",    "path": "~/projects/docs"   },
            { "name": "company", "path": "~/brain/companies" }
          ]
        }
      }
    }
  }
}
```

### Skill-based installation (recommended)

User tells the agent:
> "帮我安装 seekx 内存后端，我的笔记在 ~/notes，API key 是 sk-xxx"

Agent reads `skills/install/SKILL.md` → runs `npm install -g seekx-openclaw`
→ edits `openclaw.json` → restarts OpenClaw → verifies `openclaw status`.
Total user interaction: one prompt + provide API key. Agent does the rest.

---

## Remaining design consideration

1. **Collection isolation**: The plugin currently creates a single SQLite
   database (`openclaw.db`) shared across all OpenClaw agents. If per-agent
   isolation is needed in the future, append the agent ID to `dbPath` if the
   host exposes a stable agent identifier.
