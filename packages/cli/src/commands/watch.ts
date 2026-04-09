/**
 * watch.ts — seekx watch [collection]
 *
 * Starts the chokidar watcher and keeps the process alive.
 * On SIGINT/SIGTERM: drains pending debounces and closes the database.
 *
 * A process-level lock file (watch.lock, same directory as the database)
 * prevents two watch instances from running against the same database
 * simultaneously.
 *
 * When no specific collection is given (watch-all mode), the watcher polls
 * store.listCollections() every 2 s and dynamically adds/removes chokidar
 * paths as collections are registered or unregistered by other processes
 * (e.g. 'seekx add' or 'seekx remove' running in another terminal).
 */

import { Watcher } from "@seekx/core";
import type { Command } from "commander";
import { acquireWatchLock, releaseWatchLock } from "../lock.ts";
import { EXIT, die, openContext, resolveJson, warn } from "../utils.ts";

const COLLECTION_SYNC_INTERVAL_MS = 2000;

export function registerWatch(program: Command): void {
  program
    .command("watch [collection]")
    .description("Watch one or all collections for file changes and re-index automatically")
    .option("--json", "Machine-readable output (one JSON event per line)")
    .action(async (collection: string | undefined, opts: { json?: boolean }, command: Command) => {
      const json = resolveJson(opts, command);
      const ctx = await openContext({ json });
      const { store, client, cfg } = ctx;

      acquireWatchLock(cfg.dbPath, json);

      const cols = collection
        ? [store.getCollection(collection)].flatMap((col) => (col ? [col] : []))
        : store.listCollections();

      // When a specific collection is requested and not found, fail immediately.
      // When watching all collections, allow zero at startup — syncCollections()
      // will pick up new ones as they are registered.
      if (collection && cols.length === 0) {
        releaseWatchLock(cfg.dbPath);
        die(`Collection '${collection}' not found.`, EXIT.USER_ERROR, json);
      }

      // Watch-all mode enables collection polling; single-collection mode does
      // not (the user named an explicit target, so auto-adding others would be
      // unexpected).
      const syncIntervalMs = collection === undefined ? COLLECTION_SYNC_INTERVAL_MS : 0;

      const watcher = new Watcher(
        store,
        client,
        cols.map((c) => ({ collection: c.name, rootPath: c.path })),
        { debounceMs: cfg.watch.debounceMs, ignore: cfg.watch.ignore, syncIntervalMs },
      );

      watcher.on("ready", () => {
        if (json) {
          console.log(JSON.stringify({ type: "ready", collections: cols.map((c) => c.name) }));
        } else if (cols.length === 0) {
          console.log(
            "No collections registered yet. Waiting for 'seekx add' — press Ctrl+C to stop.",
          );
        } else {
          console.log(`Watching ${cols.length} collection(s). Press Ctrl+C to stop.`);
        }
      });

      watcher.on("event", (e) => {
        if (json) {
          console.log(JSON.stringify(e));
          return;
        }

        if (e.type === "indexed") {
          const r = e.result;
          if (r.status === "indexed") {
            console.log(
              `  + indexed  ${r.path} (${r.chunkCount} chunks, ${r.embeddedCount} embedded)`,
            );
          } else if (r.status === "mtime_only") {
            console.log(`  ~ mtime    ${r.path}`);
          }
        } else if (e.type === "removed") {
          console.log(`  - removed  ${e.path}`);
        } else if (e.type === "error") {
          warn(`  ! error    ${e.path}: ${e.error}`);
        } else if (e.type === "collection_added") {
          console.log(`  + collection added: ${e.collection}`);
        } else if (e.type === "collection_removed") {
          console.log(`  - collection removed: ${e.collection}`);
        }
      });

      watcher.start();

      const shutdown = async () => {
        if (!json) console.log("\nStopping watcher…");
        releaseWatchLock(cfg.dbPath);
        await watcher.stop();
        ctx.db.close();
        process.exit(EXIT.OK);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
