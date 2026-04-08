/**
 * vsearch.ts — seekx vsearch <query>
 *
 * Pure vector (embedding) search, bypassing BM25 and reranking.
 * Useful for semantic similarity without lexical matching.
 */

import { hybridSearch } from "@seekx/core";
import type { Command } from "commander";
import { formatSearchResults } from "../formatter.ts";
import { EXIT, die, openContext, warn } from "../utils.ts";

export function registerVsearch(program: Command): void {
  program
    .command("vsearch <query>")
    .description("Pure semantic search (requires embed API)")
    .option("-c, --collection <name>", "Restrict search to a specific collection")
    .option("-n, --limit <number>", "Maximum number of results", "10")
    .option("--json", "Machine-readable output")
    .option("--files", "Print matching file paths only")
    .action(
      async (
        query: string,
        opts: { collection?: string; limit: string; json?: boolean; files?: boolean },
      ) => {
        const ctx = await openContext({ json: opts.json });
        const { store, client } = ctx;

        if (!client) {
          die(
            "Vector search requires an embed API. Configure it with 'seekx onboard'.",
            EXIT.USER_ERROR,
            opts.json,
          );
        }

        const limit = Number.parseInt(opts.limit, 10);
        if (Number.isNaN(limit) || limit < 1) {
          die("--limit must be a positive integer.", EXIT.USER_ERROR, opts.json);
        }

        const { results, warnings } = await hybridSearch(store, client, query, {
          ...(opts.collection ? { collections: [opts.collection] } : {}),
          limit,
          mode: "vector",
          useRerank: false,
          useExpand: false,
        });

        for (const w of warnings) warn(w);

        if (results.length === 0) {
          if (!opts.json) console.log("No results.");
          ctx.db.close();
          process.exit(EXIT.NO_RESULTS);
        }

        formatSearchResults(results, { json: opts.json, files: opts.files });
        ctx.db.close();
      },
    );
}
