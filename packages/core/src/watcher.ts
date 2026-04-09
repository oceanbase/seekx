/**
 * watcher.ts — chokidar-based real-time file watcher.
 *
 * - Uses debouncing (default 500 ms) to batch rapid filesystem events.
 * - On add/change: calls indexFile() for incremental re-index.
 * - On unlink: calls store.deleteDocumentByPath() to remove stale data.
 * - Emits 'indexed', 'removed', 'error' events for the CLI to surface.
 */

import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { SeekxClient } from "./client.ts";
import { type IndexFileResult, indexFile } from "./indexer.ts";
import type { Store } from "./store.ts";

export type WatcherEvent =
  | { type: "indexed"; result: IndexFileResult }
  | { type: "removed"; path: string }
  | { type: "error"; path: string; error: unknown };

export interface WatchOptions {
  debounceMs?: number;
  ignore?: string[];
}

export interface CollectionWatch {
  collection: string;
  rootPath: string;
}

export class Watcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  /** Paths whose indexFile() call is currently in flight (awaiting embed, etc.). */
  private readonly inProgressSet = new Set<string>();
  /**
   * Paths that received a filesystem change while their indexFile() was in
   * flight. After the in-flight call finishes we immediately re-index them so
   * no write is silently lost.
   */
  private readonly pendingSet = new Set<string>();
  private readonly debounceMs: number;
  private readonly ignore: string[];
  private readonly collections: CollectionWatch[];
  private readonly store: Store;
  private readonly client: SeekxClient | null;

  constructor(
    store: Store,
    client: SeekxClient | null,
    collections: CollectionWatch[],
    opts: WatchOptions = {},
  ) {
    super();
    this.store = store;
    this.client = client;
    this.collections = collections;
    this.debounceMs = opts.debounceMs ?? 500;
    this.ignore = opts.ignore ?? [];
  }

  start(): void {
    const watchPaths = this.collections.map((c) => resolve(c.rootPath));

    this.watcher = watch(watchPaths, {
      ignored: [/(^|[/\\])\../, ...this.ignore],
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    this.watcher
      .on("add", (path) => this.handleChange(path))
      .on("change", (path) => this.handleChange(path))
      .on("unlink", (path) => this.handleUnlink(path))
      .on("ready", () => this.emit("ready"))
      .on("error", (err) => this.emit("event", { type: "error", path: "", error: err }));
  }

  async stop(): Promise<void> {
    for (const timer of this.debounceMap.values()) clearTimeout(timer);
    this.debounceMap.clear();
    this.pendingSet.clear();
    // inProgressSet: in-flight indexFile() calls will still complete; we only
    // stop accepting new work by clearing pending and closing the watcher.
    await this.watcher?.close();
    this.watcher = null;
  }

  private handleChange(absPath: string): void {
    const existingTimer = this.debounceMap.get(absPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.debounceMap.delete(absPath);
      const col = this.collectionForPath(absPath);
      if (!col) return;

      if (this.inProgressSet.has(absPath)) {
        // Another indexFile() for this path is still awaiting its embed call.
        // Mark it so we re-index immediately once that call finishes, rather
        // than letting the two calls race on the same SQLite rows.
        this.pendingSet.add(absPath);
        return;
      }

      this.runIndex(col, absPath);
    }, this.debounceMs);
    this.debounceMap.set(absPath, timer);
  }

  private runIndex(col: CollectionWatch, absPath: string): void {
    this.inProgressSet.add(absPath);
    indexFile(this.store, this.client, col.collection, absPath)
      .then((result) => this.emit("event", { type: "indexed", result }))
      .catch((err) => this.emit("event", { type: "error", path: absPath, error: err }))
      .finally(() => {
        this.inProgressSet.delete(absPath);
        if (this.pendingSet.has(absPath)) {
          this.pendingSet.delete(absPath);
          // A change arrived while we were in flight — re-index immediately.
          const col2 = this.collectionForPath(absPath);
          if (col2) this.runIndex(col2, absPath);
        }
      });
  }

  private handleUnlink(absPath: string): void {
    const col = this.collectionForPath(absPath);
    if (!col) return;
    try {
      this.store.deleteDocumentByPath(col.collection, absPath);
      this.emit("event", { type: "removed", path: absPath });
    } catch (err) {
      this.emit("event", { type: "error", path: absPath, error: err });
    }
  }

  private collectionForPath(absPath: string): CollectionWatch | null {
    for (const col of this.collections) {
      if (absPath.startsWith(resolve(col.rootPath))) return col;
    }
    return null;
  }
}
