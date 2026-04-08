/**
 * get.ts — seekx get <docid>
 *
 * Retrieves and displays a document or specific chunk by its short id.
 * Useful for exploring search results in depth.
 */

import type { Command } from "commander";
import { formatChunk } from "../formatter.ts";
import { EXIT, die, openContext } from "../utils.ts";

export function registerGet(program: Command): void {
  program
    .command("get <docid>")
    .description("Retrieve a document or chunk by its id")
    .option("--json", "Machine-readable output")
    .option("--md", "Markdown output")
    .action(async (docid: string, opts: { json?: boolean; md?: boolean }) => {
      const ctx = await openContext({ json: opts.json });
      const { store } = ctx;

      const numId = store.decodeDocid(docid);
      if (numId == null) {
        die(`Invalid document id: ${docid}`, EXIT.USER_ERROR, opts.json);
      }

      const doc = store.getDocumentById(numId);
      if (!doc) {
        die(`Document not found: ${docid}`, EXIT.USER_ERROR, opts.json);
      }

      // doc.chunks is pre-populated by getDocumentById.
      const { chunks, ...docMeta } = doc;

      if (opts.json) {
        console.log(JSON.stringify({ ...docMeta, chunks }, null, 2));
      } else {
        const content = chunks.map((c) => c.content).join("\n\n---\n\n");
        formatChunk(
          {
            file: docMeta.path,
            title: docMeta.title,
            content,
            start_line: 0,
            end_line: chunks.at(-1)?.end_line ?? 0,
          },
          { md: opts.md },
        );
      }

      ctx.db.close();
    });
}
