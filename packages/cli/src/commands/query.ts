/**
 * query.ts — seekx query <question>
 *
 * Full pipeline: expand → hybrid search → rerank, returning rich results
 * intended for AI agent consumption (MCP) or interactive use.
 *
 * Differences from seekx search:
 *   - Always enables expand (LLM query rewriting).
 *   - Adds expandedQueries to output.
 *   - Aliases as "q".
 */

import { hybridSearch } from "seekx-core";
import type { Command } from "commander";
import { formatSearchResults } from "../formatter.ts";
import { createSearchProgressReporter } from "../progress.ts";
import { EXIT, die, openContext, resolveJson, warn } from "../utils.ts";

export function registerQuery(program: Command): void {
  program
    .command("query <question>")
    .alias("q")
    .description("Search with automatic query expansion and reranking")
    .option("-c, --collection <name>", "Restrict search to a specific collection")
    .option("-n, --limit <number>", "Maximum number of results")
    .option("--json", "Machine-readable output")
    .option("--md", "Markdown output")
    .action(
      async (
        question: string,
        opts: { collection?: string; limit?: string; json?: boolean; md?: boolean },
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
        let searchResult;
        try {
          searchResult = await hybridSearch(store, client, question, {
            ...(opts.collection ? { collections: [opts.collection] } : {}),
            limit,
            minScore: cfg.search.minScore,
            minResultScore: cfg.search.minResultScore,
            mode: "hybrid",
            useRerank: cfg.search.rerank,
            useExpand: true,
            onProgress: progress.onProgress,
          });
        } finally {
          progress.finish();
        }
        const { results, expandedQueries, warnings } = searchResult;

        for (const w of warnings) warn(w);

        if (results.length === 0) {
          if (!json) console.log("No results.");
          ctx.db.close();
          process.exit(EXIT.NO_RESULTS);
        }

        formatSearchResults(results, {
          json,
          md: opts.md,
          expandedQueries,
        });
        ctx.db.close();
      },
    );
}
