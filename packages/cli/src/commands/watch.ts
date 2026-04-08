/**
 * watch.ts — seekx watch [collection]
 *
 * Starts the chokidar watcher and keeps the process alive.
 * On SIGINT/SIGTERM: drains pending debounces and closes the database.
 */

import { Watcher } from "@seekx/core";
import type { Command } from "commander";
import { EXIT, die, openContext, resolveJson, warn } from "../utils.ts";

export function registerWatch(program: Command): void {
  program
    .command("watch [collection]")
    .description("Watch one or all collections for file changes and re-index automatically")
    .option("--json", "Machine-readable output (one JSON event per line)")
    .action(async (collection: string | undefined, opts: { json?: boolean }, command: Command) => {
      const json = resolveJson(opts, command);
      const ctx = await openContext({ json });
      const { store, client, cfg } = ctx;

      const cols = collection
        ? [store.getCollection(collection)].flatMap((col) => (col ? [col] : []))
        : store.listCollections();

      if (cols.length === 0) {
        die(
          collection
            ? `Collection '${collection}' not found.`
            : "No collections registered. Use 'seekx add <path>' first.",
          EXIT.USER_ERROR,
          json,
        );
      }

      const watcher = new Watcher(
        store,
        client,
        cols.map((c) => ({ collection: c.name, rootPath: c.path })),
        { debounceMs: cfg.watch.debounceMs, ignore: cfg.watch.ignore },
      );

      watcher.on("ready", () => {
        if (json) {
          console.log(JSON.stringify({ type: "ready", collections: cols.map((c) => c.name) }));
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
        }
      });

      watcher.start();

      const shutdown = async () => {
        if (!json) console.log("\nStopping watcher…");
        await watcher.stop();
        ctx.db.close();
        process.exit(EXIT.OK);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
