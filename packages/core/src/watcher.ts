/**
 * watcher.ts — chokidar-based real-time file watcher.
 *
 * - Uses debouncing (default 500 ms) to batch rapid filesystem events.
 * - On add/change: calls indexFile() for incremental re-index.
 * - On unlink: calls store.deleteDocumentByPath() to remove stale data.
 * - Emits 'indexed', 'removed', 'error', 'collection_added', 'collection_removed'
 *   events for the CLI to surface.
 *
 * Collection sync (when syncIntervalMs > 0):
 *   Every syncIntervalMs milliseconds, syncCollections() polls store.listCollections()
 *   and diffs against the in-memory collection list. New collections are added to
 *   chokidar; removed ones are unwatched. This makes the watcher self-healing
 *   against 'seekx add' / 'seekx remove' running in another process.
 *
 * Concurrency invariants:
 *   - JS is single-threaded; syncCollections() runs as an event-loop task and
 *     cannot interleave with other synchronous code in this file.
 *   - When a collection is removed, debounceMap timers for its paths are cancelled
 *     (they haven't started yet) and pendingSet entries are cleared (prevents
 *     re-queue after an in-flight call finishes). inProgressSet entries are left
 *     intentionally: the in-flight indexFile() call completes normally, its
 *     .finally() finds collectionForPath() → null and does not re-queue.
 *     Removing a path from inProgressSet while its async indexFile() is awaiting
 *     would allow a concurrent debounce to call runIndex() again, creating two
 *     concurrent writers on the same SQLite rows.
 */

import { EventEmitter } from "node:events";
import { sep, resolve } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { SeekxClient } from "./client.ts";
import { type IndexFileResult, indexFile } from "./indexer.ts";
import type { Store } from "./store.ts";

export type WatcherEvent =
  | { type: "indexed"; result: IndexFileResult }
  | { type: "removed"; path: string }
  | { type: "error"; path: string; error: unknown }
  | { type: "collection_added"; collection: string }
  | { type: "collection_removed"; collection: string };

export interface WatchOptions {
  debounceMs?: number;
  ignore?: string[];
  /**
   * Interval in milliseconds to poll store.listCollections() for changes.
   * When > 0, the watcher dynamically adds/removes chokidar paths as
   * collections are registered or unregistered in the database.
   * Default: 0 (disabled).
   */
  syncIntervalMs?: number;
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
  /** Mutable: updated by syncCollections() as collections are added/removed. */
  private collections: CollectionWatch[];
  private readonly store: Store;
  private readonly client: SeekxClient | null;
  private readonly syncIntervalMs: number;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: Store,
    client: SeekxClient | null,
    collections: CollectionWatch[],
    opts: WatchOptions = {},
  ) {
    super();
    this.store = store;
    this.client = client;
    this.collections = [...collections];
    this.debounceMs = opts.debounceMs ?? 500;
    this.ignore = opts.ignore ?? [];
    this.syncIntervalMs = opts.syncIntervalMs ?? 0;
  }

  start(): void {
    const watchPaths = this.collections.map((c) => resolve(c.rootPath));

    // chokidar accepts an empty array and emits "ready" immediately; paths are
    // added dynamically via watcher.add() as syncCollections() discovers them.
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

    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => this.syncCollections(), this.syncIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const timer of this.debounceMap.values()) clearTimeout(timer);
    this.debounceMap.clear();
    this.pendingSet.clear();
    // inProgressSet: in-flight indexFile() calls will still complete; we only
    // stop accepting new work by clearing pending and closing the watcher.
    await this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Synchronise the in-memory collection list against the database.
   *
   * Called periodically by the setInterval started in start(). All operations
   * here are synchronous (better-sqlite3 / Bun SQLite), so this entire method
   * runs atomically within a single event-loop turn — no interleaving with
   * debounce callbacks or runIndex().
   */
  private syncCollections(): void {
    const currentByName = new Map(this.collections.map((c) => [c.collection, c]));
    const freshRows = this.store.listCollections();
    const freshByName = new Map(
      freshRows.map((r) => [r.name, { collection: r.name, rootPath: r.path } as CollectionWatch]),
    );

    // Added: present in DB but not yet watched.
    for (const [name, col] of freshByName) {
      if (!currentByName.has(name)) {
        this.collections.push(col);
        this.watcher?.add(resolve(col.rootPath));
        this.emit("event", { type: "collection_added", collection: name });
      }
    }

    // Removed: previously watched but no longer in DB.
    for (const [name, col] of currentByName) {
      if (!freshByName.has(name)) {
        this.collections = this.collections.filter((c) => c.collection !== name);
        const rootAbs = resolve(col.rootPath);

        // Cancel debounce timers that haven't fired yet.
        for (const [path, timer] of this.debounceMap) {
          if (path.startsWith(rootAbs + sep) || path === rootAbs) {
            clearTimeout(timer);
            this.debounceMap.delete(path);
          }
        }

        // Suppress re-queuing: if an in-flight runIndex() finishes for a path
        // under this root, its .finally() checks pendingSet. Clearing here
        // prevents a redundant re-index. inProgressSet is NOT cleared — see
        // module-level concurrency note.
        for (const path of this.pendingSet) {
          if (path.startsWith(rootAbs + sep) || path === rootAbs) {
            this.pendingSet.delete(path);
          }
        }

        this.watcher?.unwatch(rootAbs);
        this.emit("event", { type: "collection_removed", collection: name });
      }
    }
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
