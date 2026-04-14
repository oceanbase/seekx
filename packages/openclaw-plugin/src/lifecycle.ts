import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private initialIndexPromise: Promise<void> = Promise.resolve();
  private indexQueue: Promise<void> = Promise.resolve();
  private stopping = false;
  private readonly shutdown = () => void this.stop();

  constructor(config: SeekxPluginConfig) {
    this.config = config;
  }

  /**
   * Open the database, register collections, run initial background indexing,
   * and start the file watcher. Idempotent — safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.stopPromise = null;
    this.startPromise = this._start();
    return this.startPromise;
  }

  async waitForSearchReady(): Promise<void> {
    await this.start();
    await this.initialIndexPromise;
  }

  async resolveReadablePath(path: string): Promise<string | null> {
    await this.start();
    const normalizedPath = resolve(path);
    for (const collection of this.store.listCollections()) {
      if (this.store.findDocumentByPath(collection.name, normalizedPath)) {
        return normalizedPath;
      }
    }
    return null;
  }

  /** Queue a full incremental index pass and wait for completion. */
  async _runFullIndex(): Promise<void> {
    await this.start();
    await this.queueFullIndex();
  }

  private async _start(): Promise<void> {
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

    const collectionWatches: CollectionWatch[] = this.store
      .listCollections()
      .map((c) => ({ collection: c.name, rootPath: c.path }));

    this.watcher = new Watcher(this.store, this.client, collectionWatches, {
      debounceMs: 1000,
    });
    this.watcher.start();

    // The plugin keeps its own index database by default, so collection sync
    // via a separate seekx CLI process is not a supported workflow.
    if (this.config.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.queueFullIndex();
      }, this.config.refreshIntervalMs);
    }

    process.once("SIGTERM", this.shutdown);
    process.once("exit", this.shutdown);

    // Startup stays non-blocking for plugin activation, but searches wait for
    // this initial pass so they do not incorrectly return an empty result set
    // before the first index has been built.
    this.initialIndexPromise = this.queueFullIndex();
  }

  private queueFullIndex(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const run = this.indexQueue.then(async () => {
      if (this.stopping) return;
      await this.runFullIndexNow();
    });
    this.indexQueue = run.catch(() => {});
    return run;
  }

  /** Run incremental indexing across all registered collections immediately. */
  private async runFullIndexNow(): Promise<void> {
    const collections = this.store.listCollections();
    for (const col of collections) {
      if (this.stopping) break;
      try {
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
    if (this.stopPromise) return this.stopPromise;
    if (!this.startPromise) return;

    this.stopping = true;
    this.stopPromise = (async () => {
      if (this.refreshTimer !== null) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
      await this.watcher?.stop();
      this.watcher = null;
      await this.indexQueue.catch(() => {});
      this.store?.close();
      this.client = null;
      process.off("SIGTERM", this.shutdown);
      process.off("exit", this.shutdown);
      this.startPromise = null;
    })();

    return this.stopPromise;
  }
}
