/**
 * remove.ts — seekx remove <collection>
 *
 * Removes a collection and all its documents, chunks, FTS, and vector data.
 */

import type { Command } from "commander";
import { EXIT, die, openContext } from "../utils.ts";

export function registerRemove(program: Command): void {
  program
    .command("remove <collection>")
    .alias("rm")
    .description("Remove a collection and all its indexed data")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--json", "Machine-readable output")
    .action(async (collection: string, opts: { yes?: boolean; json?: boolean }) => {
      const ctx = await openContext({ json: opts.json });
      const { store } = ctx;

      const col = store.getCollection(collection);
      if (!col) {
        die(`Collection '${collection}' not found.`, EXIT.USER_ERROR, opts.json);
      }

      if (!opts.yes && !opts.json) {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) =>
          rl.question(`Remove collection '${collection}' (${col.path})? [y/N] `, resolve),
        );
        rl.close();
        if (answer.toLowerCase() !== "y") {
          console.log("Aborted.");
          ctx.db.close();
          process.exit(EXIT.OK);
        }
      }

      store.removeCollection(collection);

      if (opts.json) {
        console.log(JSON.stringify({ removed: collection }));
      } else {
        console.log(`Collection '${collection}' removed.`);
      }

      ctx.db.close();
    });
}
