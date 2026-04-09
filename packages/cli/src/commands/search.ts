/**
 * search.ts — seekx search <query>
 *
 * Hybrid BM25 + vector search with optional reranking and query expansion.
 * Exits with code 1 if no results, 2 if API degraded.
 */

import { hybridSearch } from "seekx-core";
import type { Command } from "commander";
import { formatSearchResults } from "../formatter.ts";
import { createSearchProgressReporter } from "../progress.ts";
import { EXIT, die, openContext, resolveJson, warn } from "../utils.ts";

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("Search across all collections (full-text + semantic)")
    .option("-c, --collection <name>", "Restrict search to a specific collection")
    .option("-n, --limit <number>", "Maximum number of results")
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
          limit?: string;
          rerank: boolean;
          expand: boolean;
          json?: boolean;
          files?: boolean;
          md?: boolean;
        },
        command: Command,
      ) => {
        const json = resolveJson(opts, command);
        const ctx = await openContext({ json });
        const { store, client, cfg } = ctx;

        const limit = opts.limit ? Number.parseInt(opts.limit, 10) : cfg.search.defaultLimit;
        if (Number.isNaN(limit) || limit < 1) {
          die("--limit must be a positive integer.", EXIT.USER_ERROR, json);
        }

        const progress = createSearchProgressReporter({ enabled: !json });
        const { results, expandedQueries, warnings } = await (async () => {
          try {
            return await hybridSearch(store, client, query, {
              ...(opts.collection ? { collections: [opts.collection] } : {}),
              limit,
              minScore: cfg.search.minScore,
              minResultScore: cfg.search.minResultScore,
              mode: "hybrid",
              useRerank: opts.rerank && cfg.search.rerank,
              useExpand: opts.expand,
              onProgress: progress.onProgress,
            });
          } finally {
            progress.finish();
          }
        })();

        for (const w of warnings) warn(w);

        if (results.length === 0) {
          if (json) {
            console.log(JSON.stringify({ results: [], expandedQueries, warnings }));
          } else {
            console.log("No results.");
          }
          ctx.db.close();
          process.exit(EXIT.NO_RESULTS);
        }

        formatSearchResults(results, {
          json,
          files: opts.files,
          md: opts.md,
          expandedQueries,
        });
        ctx.db.close();
      },
    );
}
