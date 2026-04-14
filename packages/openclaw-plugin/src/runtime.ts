import { readFileSync } from "node:fs";
import { hybridSearch } from "seekx-core";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemorySearchOpts,
} from "openclaw/plugin-sdk/plugin-entry";
import type { SeekxLifecycle } from "./lifecycle.ts";
import { readPersistedSeekxStatusSync } from "./status-db.ts";

type StatusSnapshot = {
  totalDocuments: number;
  totalChunks: number;
  embeddedChunks: number;
  vectorSearchAvailable: boolean;
  embedModel: string | null;
  collections: Array<{
    name: string;
    path: string;
    docCount: number;
  }>;
};

function buildStatusResponse(lc: SeekxLifecycle, snapshot: StatusSnapshot) {
  return {
    backend: "seekx" as const,
    provider: "seekx",
    dbPath: lc.config.dbPath,
    files: snapshot.totalDocuments,
    chunks: snapshot.totalChunks,
    vector: {
      enabled: snapshot.vectorSearchAvailable,
      available: snapshot.vectorSearchAvailable,
    },
    custom: {
      embeddedChunks: snapshot.embeddedChunks,
      embedModel: snapshot.embedModel,
      collections: snapshot.collections.map((c) => ({
        name: c.name,
        path: c.path,
        docCount: c.docCount,
      })),
    },
  };
}

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
      await lc.waitForSearchReady();
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
      const readablePath = await lc.resolveReadablePath(path);
      if (!readablePath) return "";
      try {
        return readFileSync(readablePath, "utf-8");
      } catch {
        return "";
      }
    },

    /**
     * status() is called SYNCHRONOUSLY by OpenClaw's status scanner.
     *
     * Field names follow MemoryProviderStatus (the real SDK type):
     *   - files  → document count
     *   - chunks → chunk count
     *
     * When the lifecycle has not yet completed start() (fresh process, status
     * probe runs before the DB is open), fall back to a direct SQLite read of
     * the persisted index state.
     */
    status() {
      const snapshot = lc.store?.getStatus() ?? readPersistedSeekxStatusSync(lc.config.dbPath);
      if (!snapshot) {
        return {
          backend: "seekx" as const,
          provider: "seekx",
          dbPath: lc.config.dbPath,
          files: 0,
          chunks: 0,
        };
      }
      return buildStatusResponse(lc, snapshot);
    },

    async probeEmbeddingAvailability(): Promise<boolean> {
      await lc.start();
      return lc.client !== null;
    },

    async probeVectorAvailability(): Promise<boolean> {
      await lc.start();
      return lc.store.getStatus().vectorSearchAvailable;
    },
  };

  return { manager };
}
