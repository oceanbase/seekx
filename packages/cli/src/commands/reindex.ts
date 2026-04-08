/**
 * reindex.ts — seekx reindex [collection]
 *
 * Forces a full re-index of one or all collections.
 * Drops and rebuilds vec_chunks when --reset-vec is given (dimension change).
 */

import { basename } from "node:path";
import { indexDirectory } from "@seekx/core";
import type { Command } from "commander";
import { EXIT, die, openContext, resolveJson, warn } from "../utils.ts";

export function registerReindex(program: Command): void {
  program
    .command("reindex [collection]")
    .description("Force re-index of a collection (or all if omitted)")
    .option("--reset-vec", "Drop and recreate the vector table (required on embed model change)")
    .option("--json", "Machine-readable output")
    .action(
      async (collection: string | undefined, opts: { resetVec?: boolean; json?: boolean }, command: Command) => {
        const json = resolveJson(opts, command);
        const ctx = await openContext({ json });
        const { store, client, cfg } = ctx;

        if (opts.resetVec) {
          store.resetVecTable();
          if (!json) console.log("Vector table reset.");
        }

        const cols = collection
          ? [store.getCollection(collection)].filter(Boolean)
          : store.listCollections();

        if (cols.length === 0) {
          die(
            collection ? `Collection '${collection}' not found.` : "No collections registered.",
            EXIT.USER_ERROR,
            json,
          );
        }

        const summary: Array<{ name: string; indexed: number; errors: number }> = [];

        for (const col of cols) {
          if (!col) continue;
          if (!json) console.log(`Re-indexing '${col.name}'…`);

          // Delete all existing docs for the collection so indexFile re-creates them.
          store.deleteAllDocuments(col.name);

          let lastPrint = 0;
          const result = await indexDirectory(
            store,
            client,
            col.name,
            col.path,
            "**/*.{md,markdown,txt}",
            cfg.watch.ignore,
            (indexed, total, filePath) => {
              const now = Date.now();
              if (!json && now - lastPrint > 500) {
                lastPrint = now;
                process.stdout.write(`\r  ${indexed}/${total} — ${basename(filePath)}          `);
              }
            },
          );

          if (!json) process.stdout.write("\n");

          if (result.errors.length > 0) {
            for (const e of result.errors) warn(`  ${e.path}: ${e.error}`);
          }

          summary.push({ name: col.name, indexed: result.indexed, errors: result.errors.length });
        }

        if (json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          for (const s of summary) {
            console.log(`  ${s.name}: ${s.indexed} indexed, ${s.errors} error(s)`);
          }
        }

        ctx.db.close();
      },
    );
}
