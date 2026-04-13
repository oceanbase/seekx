import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
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

/** Collection name for OpenClaw's built-in memory files. */
const OPENCLAW_MEMORY_COLLECTION = "openclaw-memory";

/**
 * Absolute path to OpenClaw's default agent workspace, which contains
 * MEMORY.md and the memory/ daily-note tree.
 */
function openClawMemoryPath(): string {
  return `${homedir()}/.openclaw/workspace`;
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
   * Open the database, register collections, run initial background indexing,
   * and start the file watcher. Idempotent — safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Ensure the database directory exists before opening.
    const dbDir = dirname(this.config.dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    this.db = await openDatabase(this.config.dbPath);
    const vecLoaded = await loadSqliteVec(this.db);
    this.store = new Store(this.db, vecLoaded);

    // Wire the store's LLM cache into the client so expand/rerank responses
    // are persisted across gateway restarts (TTL 1 hour).
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

    // Initial indexing runs in the background — does not block plugin startup.
    void this._runFullIndex();

    // File watcher: covers all registered collections. syncIntervalMs lets
    // the watcher pick up collections added by `seekx add` in another process
    // without requiring a gateway restart.
    const collectionWatches: CollectionWatch[] = this.store
      .listCollections()
      .map((c) => ({ collection: c.name, rootPath: c.path }));

    this.watcher = new Watcher(this.store, this.client, collectionWatches, {
      debounceMs: 1000,
      syncIntervalMs: 30_000,
    });
    this.watcher.start();

    // Periodic full re-index — safety net for missed watcher events
    // (network drives, Docker bind mounts, etc.).
    if (this.config.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(
        () => void this._runFullIndex(),
        this.config.refreshIntervalMs,
      );
    }

    // Ensure clean shutdown on process exit even if registerService() is
    // not wired up by the host (e.g. during testing).
    const shutdown = () => void this.stop();
    process.once("SIGTERM", shutdown);
    process.once("exit", shutdown);
  }

  /** Run incremental indexing across all registered collections. */
  async _runFullIndex(): Promise<void> {
    const collections = this.store.listCollections();
    for (const col of collections) {
      try {
        // Actual signature: (store, client, collection, rootPath, pattern, ignore, onProgress?)
        await indexDirectory(
          this.store,
          this.client,
          col.name,
          col.path,
          col.pattern,
          col.ignore_json ? (JSON.parse(col.ignore_json) as string[]) : [],
        );
      } catch (err) {
        console.error(`[seekx-openclaw] indexDirectory error for "${col.name}": ${err}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.watcher?.stop();
    this.store?.close();
  }
}
