import { readFileSync } from "node:fs";
import { hybridSearch, type SearchResult } from "seekx-core";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemorySearchOpts,
} from "openclaw/plugin-sdk/plugin-entry";
import type { SeekxLifecycle } from "./lifecycle.ts";
import { readPersistedSeekxStatusSync } from "./status-db.ts";

export class SearchTimeoutError extends Error {
  constructor(ms: number) {
    super(`Search timed out after ${ms}ms`);
    this.name = "SearchTimeoutError";
  }
}

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
     *
     * Citations: when citations mode is "auto" or "on", a Source: footer is
     * appended to each snippet so the agent can trace provenance.
     *
     * Timeout: protects against runaway searches (default 8 s).
     * A value of 0 disables the timeout.
     */
    async search(query: string, opts: MemorySearchOpts): Promise<MemorySearchResult[]> {
      await lc.waitForSearchReady();
      const limit = opts.limit ?? lc.config.searchLimit;

      const searchPromise = hybridSearch(lc.store, lc.client, query, {
        limit,
        mode: "hybrid",
        useExpand: lc.config.expand !== null,
        useRerank: lc.config.rerank !== null,
        minResultScore: 0.01,
        ...(opts.collection ? { collections: [opts.collection] } : {}),
      });

      const timeoutMs = lc.config.searchTimeoutMs;
      const { results } = timeoutMs > 0
        ? await withTimeout(searchPromise, timeoutMs)
        : await searchPromise;

      const citations = opts.citations ?? lc.config.citations;

      return results.map((r) => ({
        path: r.file,
        content: appendCitation(r, citations),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Append a `Source: path#line` citation footer to the snippet when citations
 * are enabled.  Matches the QMD citation format that OpenClaw agents expect.
 */
function appendCitation(
  r: SearchResult,
  mode: "auto" | "on" | "off",
): string {
  if (mode === "off") return r.snippet;
  const line = r.start_line > 0 ? `#${r.start_line}` : "";
  return `${r.snippet}\nSource: ${r.file}${line}`;
}

/**
 * Race a promise against a timeout.  Rejects with SearchTimeoutError if the
 * timeout fires first.  The underlying promise is NOT cancelled (JS has no
 * cancellation primitive for arbitrary promises), but its result will be
 * silently dropped.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SearchTimeoutError(ms)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
