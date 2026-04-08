/**
 * search.ts — seekx search <query>
 *
 * Hybrid BM25 + vector search with optional reranking and query expansion.
 * Exits with code 1 if no results, 2 if API degraded.
 */

import type { Command } from "commander";
import { hybridSearch } from "@seekx/core";
import { formatSearchResults } from "../formatter.ts";
import { die, EXIT, openContext, warn } from "../utils.ts";

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("Search across all collections (full-text + semantic)")
    .option("-c, --collection <name>", "Restrict search to a specific collection")
    .option("-n, --limit <number>", "Maximum number of results", "10")
    .option("--no-rerank", "Disable cross-encoder reranking")
    .option("--no-expand", "Disable query expansion")
    .option("--json", "Machine-readable output")
    .option("--files", "Print matching file paths only")
    .option("--md", "Markdown output")
    .action(
      async (
        query: string,
        opts: {
          collection?: string;
          limit: string;
          rerank: boolean;
          expand: boolean;
          json?: boolean;
          files?: boolean;
          md?: boolean;
        },
      ) => {
        const ctx = await openContext({ json: opts.json });
        const { store, client, cfg } = ctx;

        const limit = Number.parseInt(opts.limit, 10);
        if (Number.isNaN(limit) || limit < 1) {
          die("--limit must be a positive integer.", EXIT.USER_ERROR, opts.json);
        }

        const { results, expandedQueries, warnings } = await hybridSearch(store, client, query, {
          ...(opts.collection ? { collections: [opts.collection] } : {}),
          limit,
          mode: "hybrid",
          useRerank: opts.rerank && cfg.search.rerank,
          useExpand: opts.expand,
        });

        for (const w of warnings) warn(w);

        if (results.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ results: [], expandedQueries, warnings }));
          } else {
            console.log("No results.");
          }
          ctx.db.close();
          process.exit(EXIT.NO_RESULTS);
        }

        formatSearchResults(results, { json: opts.json, files: opts.files, md: opts.md, expandedQueries });
        ctx.db.close();
      },
    );
}
