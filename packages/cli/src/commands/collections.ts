/**
 * collections.ts — seekx collections
 *
 * Lists all registered collections with document and chunk counts.
 */

import type { Command } from "commander";
import { formatCollections } from "../formatter.ts";
import { openContext } from "../utils.ts";

export function registerCollections(program: Command): void {
  program
    .command("collections")
    .alias("ls")
    .description("List all registered collections")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const ctx = await openContext({ json: opts.json });
      const { store } = ctx;

      const cols = store.listCollections();
      const rows = cols.map((c) => {
        const stats = store.collectionStats(c.name);
        return { name: c.name, path: c.path, docCount: stats.docCount, chunkCount: stats.chunkCount };
      });

      formatCollections(rows, { json: opts.json });
      ctx.db.close();
    });
}
