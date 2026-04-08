/**
 * add.ts — seekx add <path> [--name <name>] [--reindex]
 *
 * Registers a directory as a collection and indexes its contents.
 * Uses indexDirectory() for the initial bulk scan, showing progress.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { indexDirectory } from "@seekx/core";
import type { Command } from "commander";
import { EXIT, die, openContext, resolveJson, warn } from "../utils.ts";

export function registerAdd(program: Command): void {
  program
    .command("add <path>")
    .description("Add a directory as a collection and index its contents")
    .option("-n, --name <name>", "Collection name (defaults to directory basename)")
    .option("--reindex", "Force re-index even if collection already exists")
    .option("--json", "Machine-readable output")
    .action(async (pathArg: string, opts: { name?: string; reindex?: boolean; json?: boolean }, command: Command) => {
      const json = resolveJson(opts, command);
      const absPath = resolve(pathArg);
      if (!existsSync(absPath)) {
        die(`Path does not exist: ${absPath}`, EXIT.USER_ERROR, json);
      }

      let realPath: string;
      try {
        realPath = realpathSync(absPath);
      } catch {
        realPath = absPath;
      }

      const ctx = await openContext({ json });
      const { store, client, cfg } = ctx;

      const name = opts.name ?? basename(realPath);

      const existing = store.getCollection(name);
      if (existing && !opts.reindex) {
        die(
          `Collection '${name}' already exists (path: ${existing.path}). Use --reindex to force re-index.`,
          EXIT.USER_ERROR,
          json,
        );
      }

      store.addCollection({ name, path: realPath });

      if (!json) {
        console.log(`Indexing '${name}' → ${realPath}`);
      }

      let lastPrint = 0;
      const result = await indexDirectory(
        store,
        client,
        name,
        realPath,
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

      if (json) {
        console.log(JSON.stringify({ name, path: realPath, ...result }, null, 2));
      } else {
        console.log(`\nDone. Indexed ${result.indexed} files, skipped ${result.skipped}.`);
        if (result.errors.length > 0) {
          warn(`${result.errors.length} error(s) during indexing:`);
          for (const e of result.errors) warn(`  ${e.path}: ${e.error}`);
        }
      }

      ctx.db.close();
    });
}
