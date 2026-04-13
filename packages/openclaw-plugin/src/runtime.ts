import { readFileSync } from "node:fs";
import { hybridSearch } from "seekx-core";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemorySearchOpts,
  BackendStatus,
} from "openclaw/plugin-sdk/plugin-entry";
import type { SeekxLifecycle } from "./lifecycle.ts";

/**
 * Build the MemorySearchManager that OpenClaw's runtime calls for
 * memory_search and memory_get tool invocations.
 *
 * Precondition: lc.start() must have been called before any method fires.
 */
export function buildMemorySearchManager(lc: SeekxLifecycle): { manager: MemorySearchManager } {
  const manager: MemorySearchManager = {
    /**
     * memory_search implementation.
     *
     * Routes through seekx's full hybrid pipeline:
     *   query expansion → BM25 + vector kNN → RRF fusion → cross-encoder rerank
     *
     * Each stage degrades gracefully when the required service is unavailable:
     *   - no expand model → original query only
     *   - no embed / sqlite-vec → BM25-only
     *   - no rerank model → RRF-ranked order used directly
     */
    async search(query: string, opts: MemorySearchOpts): Promise<MemorySearchResult[]> {
      const limit = opts.limit ?? lc.config.searchLimit;
      const { results } = await hybridSearch(lc.store, lc.client, query, {
        limit,
        mode: "hybrid",
        useExpand: lc.config.expand !== null,
        useRerank: lc.config.rerank !== null,
        minResultScore: 0.01,
        ...(opts.collection ? { collections: [opts.collection] } : {}),
      });

      return results.map((r) => ({
        path: r.file,
        content: r.snippet,
        score: r.score,
        collection: r.collection,
        title: r.title ?? null,
      }));
    },

    /**
     * memory_get implementation.
     *
     * Reads the live file from disk rather than the indexed snapshot, ensuring
     * the agent always sees the current version of a document.
     * Returns an empty string if the file has been deleted since indexing.
     */
    async readFile(path: string): Promise<string> {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return "";
      }
    },

    async status(): Promise<BackendStatus> {
      const s = lc.store.getStatus();
      return {
        backend: "seekx",
        dbPath: lc.config.dbPath,
        documents: s.totalDocuments,
        chunks: s.totalChunks,
        embeddedChunks: s.embeddedChunks,
        vectorSearchAvailable: s.vectorSearchAvailable,
        embedModel: s.embedModel,
        collections: s.collections.map((c) => ({
          name: c.name,
          path: c.path,
          docCount: c.docCount,
        })),
      };
    },

    async probeEmbeddingAvailability(): Promise<boolean> {
      if (!lc.client) return false;
      const { embed } = lc.config;
      return Boolean(embed.baseUrl && embed.model && embed.apiKey);
    },

    async probeVectorAvailability(): Promise<boolean> {
      return lc.store.getStatus().vectorSearchAvailable;
    },
  };

  return { manager };
}
