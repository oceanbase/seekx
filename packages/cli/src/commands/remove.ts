/**
 * remove.ts — seekx remove <collection>
 *
 * Removes a collection and all its documents, chunks, FTS, and vector data.
 */

import type { Command } from "commander";
import { EXIT, die, openContext, resolveJson } from "../utils.ts";

export function registerRemove(program: Command): void {
  program
    .command("remove <collection>")
    .alias("rm")
    .description("Remove a collection from the index (original files are NOT deleted)")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--json", "Machine-readable output")
    .action(
      async (collection: string, opts: { yes?: boolean; json?: boolean }, command: Command) => {
        const json = resolveJson(opts, command);
        const ctx = await openContext({ json });
        const { store } = ctx;

        const col = store.getCollection(collection);
        if (!col) {
          die(`Collection '${collection}' not found.`, EXIT.USER_ERROR, json);
        }

        if (!opts.yes && !json) {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) =>
            rl.question(
              `Remove index for '${collection}' (${col.path})?\n` +
                `  Your files will NOT be deleted — only the seekx index entries.\n` +
                `  Confirm [y/N] `,
              resolve,
            ),
          );
          rl.close();
          if (answer.toLowerCase() !== "y") {
            console.log("Aborted.");
            ctx.db.close();
            process.exit(EXIT.OK);
          }
        }

        store.removeCollection(collection);

        if (json) {
          console.log(JSON.stringify({ removed: collection }));
        } else {
          console.log(`Index for collection '${collection}' removed. Your files are untouched.`);
        }

        ctx.db.close();
      },
    );
}
