/**
 * mcp.ts — seekx mcp
 *
 * Starts a Model Context Protocol (MCP) server over stdio.
 * Exposes 4 tools to AI agents: search, get, list, status.
 *
 * The MCP server uses @modelcontextprotocol/sdk (stdio transport).
 */

import type { Command } from "commander";
import { CLI_VERSION } from "../version.ts";
import { openContext } from "../utils.ts";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("Start MCP server for AI agent integration")
    .action(async () => {
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { hybridSearch } = await import("seekx-core");
      const { z } = await import("zod");

      const ctx = await openContext({});
      const { store, client, cfg } = ctx;

      const cols = store.listCollections();
      const totalDocs = cols.reduce((s, c) => s + store.collectionStats(c.name).docCount, 0);

      const server = new McpServer({
        name: "seekx",
        version: CLI_VERSION,
        description: `seekx — context search engine. ${totalDocs} documents indexed across ${cols.length} collection(s): ${cols.map((c) => c.name).join(", ")}.`,
      });

      // Tool: search
      server.tool(
        "search",
        "Hybrid full-text and semantic search over the knowledge base.",
        {
          query: z.string().describe("Search query"),
          collection: z.string().optional().describe("Restrict to a specific collection"),
          limit: z.number().int().min(1).max(50).default(cfg.search.defaultLimit).describe("Max results"),
        },
        async ({ query, collection, limit }) => {
          const { results } = await hybridSearch(store, client, query, {
            ...(collection ? { collections: [collection] } : {}),
            limit: limit ?? cfg.search.defaultLimit,
            minScore: cfg.search.minScore,
            minResultScore: cfg.search.minResultScore,
            mode: "hybrid",
            useRerank: cfg.search.rerank,
            useExpand: true,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
          };
        },
      );

      // Tool: get
      server.tool(
        "get",
        "Retrieve the full content of a document by its id.",
        { docid: z.string().describe("Document id from search results") },
        async ({ docid }) => {
          const numId = store.decodeDocid(docid);
          if (!numId) return { content: [{ type: "text" as const, text: "Document not found." }] };
          const doc = store.getDocumentById(numId);
          if (!doc) return { content: [{ type: "text" as const, text: "Document not found." }] };
          const chunks = store.getChunksByDocId(numId);
          const content = chunks.map((c) => c.content).join("\n\n");
          return { content: [{ type: "text" as const, text: content }] };
        },
      );

      // Tool: list
      server.tool("list", "List all registered collections.", {}, async () => {
        const collections = store.listCollections().map((c) => ({
          ...c,
          ...store.collectionStats(c.name),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(collections, null, 2) }] };
      });

      // Tool: status
      server.tool("status", "Report index health and statistics.", {}, async () => {
        const collections = store.listCollections();
        const totalChunks = collections.reduce(
          (s, c) => s + store.collectionStats(c.name).chunkCount,
          0,
        );
        const docs = collections.reduce((s, c) => s + store.collectionStats(c.name).docCount, 0);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                documents: docs,
                chunks: totalChunks,
                vecLoaded: ctx.vecLoaded,
              }),
            },
          ],
        };
      });

      const transport = new StdioServerTransport();
      await server.connect(transport);
    });
}
