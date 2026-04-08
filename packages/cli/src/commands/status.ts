/**
 * status.ts — seekx status
 *
 * Shows environment health (sqlite-vec, embed API) and full index statistics
 * from store.getStatus(): document/chunk counts, embedding coverage,
 * embed model name and dimension.
 */

import { isEmbedConfigured } from "@seekx/core";
import type { Command } from "commander";
import { formatStatus } from "../formatter.ts";
import { openContext } from "../utils.ts";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show index statistics and environment health")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const ctx = await openContext({ json: opts.json });
      const { store, client, cfg } = ctx;

      let embedOk: boolean | null = null;
      if (client && isEmbedConfigured(cfg)) {
        const h = await client.healthCheck();
        embedOk = h.embed?.ok ?? false;
      }

      // getStatus() returns rich IndexStatus with embedded chunk counts,
      // embed model name, dim, and per-collection last_indexed timestamps.
      const status = store.getStatus();

      formatStatus({ ...status, dbPath: cfg.dbPath, embedOk }, { json: opts.json });

      ctx.db.close();
    });
}
