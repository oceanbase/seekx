/**
 * search.test.ts — Unit tests for the hybrid search pipeline.
 *
 * All remote API calls (embed, rerank, expand) use a stub SeekxClient
 * that returns predictable results without network access.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SeekxClient } from "../src/client.ts";
import { openDatabase } from "../src/db.ts";
import type { Database } from "../src/db.ts";
import { type SearchProgressEvent, hybridSearch } from "../src/search.ts";
import { type RawResult, Store } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Minimal SeekxClient stub
// ---------------------------------------------------------------------------

function makeClientStub(embedReply: number[][] | null = null): SeekxClient {
  return {
    embed: async (_texts: string[]) => embedReply,
    rerank: async () => null,
    expand: async () => null,
    healthCheck: async () => ({ embed: null, rerank: null, expand: null }),
  } as unknown as SeekxClient;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let db: Database;
let store: Store;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  store = new Store(db, false);
  store.addCollection({ name: "col", path: "/col" });

  // Insert two documents with distinct content
  const docA = store.upsertDocument({
    collection: "col",
    path: "/col/a.md",
    title: "Alpha",
    mtime: 1,
    hash: "ha",
  });
  const cA = store.insertChunk({
    doc_id: docA,
    chunk_idx: 0,
    content: "machine learning algorithms",
    heading_path: null,
    start_line: 0,
    end_line: 3,
    token_count: 3,
  });
  store.insertFTS(cA, "machine learning algorithms");

  const docB = store.upsertDocument({
    collection: "col",
    path: "/col/b.md",
    title: "Beta",
    mtime: 1,
    hash: "hb",
  });
  const cB = store.insertChunk({
    doc_id: docB,
    chunk_idx: 0,
    content: "vector database embeddings",
    heading_path: null,
    start_line: 0,
    end_line: 3,
    token_count: 3,
  });
  store.insertFTS(cB, "vector database embeddings");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hybridSearch — BM25 only (no client)", () => {
  test("finds relevant result for English query", async () => {
    const { results } = await hybridSearch(store, null, "machine learning", { mode: "bm25" });
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.file);
    expect(paths).toContain("/col/a.md");
  });

  test("returns empty for unmatched query", async () => {
    const { results } = await hybridSearch(store, null, "zzznomatch", { mode: "bm25" });
    expect(results.length).toBe(0);
  });

  test("respects limit", async () => {
    const { results } = await hybridSearch(store, null, "database", { mode: "bm25", limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe("hybridSearch — collection filter", () => {
  test("excludes results outside requested collections", async () => {
    const { results } = await hybridSearch(store, null, "machine", {
      mode: "bm25",
      collections: ["other"],
    });
    expect(results.length).toBe(0);
  });
});

describe("hybridSearch — result structure", () => {
  test("result has required fields", async () => {
    const { results } = await hybridSearch(store, null, "vector", { mode: "bm25" });
    if (results.length > 0) {
      const r = results[0];
      if (!r) throw new Error("Expected at least one search result");
      expect(typeof r.file).toBe("string");
      expect(typeof r.score).toBe("number");
      expect(typeof r.snippet).toBe("string");
      expect(typeof r.chunk_id).toBe("number");
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("hybridSearch — client fail-open", () => {
  test("falls back to BM25 when embed returns null", async () => {
    const client = makeClientStub(null);
    const { results } = await hybridSearch(store, client, "machine", {
      mode: "hybrid",
      useExpand: false,
    });
    // Should still get BM25 results despite failed embed
    expect(results.length).toBeGreaterThan(0);
  });

  test("emits structured phase events for hybrid search", async () => {
    const events: SearchProgressEvent[] = [];
    const docC = store.upsertDocument({
      collection: "col",
      path: "/col/c.md",
      title: "Gamma",
      mtime: 1,
      hash: "hc",
    });
    const cC = store.insertChunk({
      doc_id: docC,
      chunk_idx: 0,
      content: "machine systems architecture",
      heading_path: null,
      start_line: 0,
      end_line: 3,
      token_count: 3,
    });
    store.insertFTS(cC, "machine systems architecture");

    const client = {
      expand: async () => ["machine", "ml systems"],
      embed: async () => [[1, 0, 0]],
      rerank: async () => null,
      healthCheck: async () => ({ embed: null, rerank: null, expand: null }),
    } as unknown as SeekxClient;

    await hybridSearch(store, client, "machine", {
      mode: "hybrid",
      useExpand: true,
      useRerank: true,
      onProgress: (event) => events.push(event),
    });

    expect(events[0]).toMatchObject({ phase: "start", mode: "hybrid" });
    expect(events.some((event) => event.phase === "expand_start")).toBe(true);
    expect(events).toContainEqual({ phase: "expand_done", expandedQueries: ["machine", "ml systems"] });
    expect(events).toContainEqual({ phase: "bm25_start", totalQueries: 2 });
    expect(events).toContainEqual({ phase: "vector_start", totalQueries: 2 });
    expect(events).toContainEqual({ phase: "rerank_start", candidateCount: 2 });
    expect(events).toContainEqual({ phase: "rerank_done", candidateCount: 2, applied: false });

    const bm25Progress = events.filter(
      (event): event is Extract<SearchProgressEvent, { phase: "bm25_progress" }> =>
        event.phase === "bm25_progress",
    );
    expect(bm25Progress.map((event) => event.completed)).toEqual([1, 2]);

    const vectorProgress = events.filter(
      (event): event is Extract<SearchProgressEvent, { phase: "vector_progress" }> =>
        event.phase === "vector_progress",
    );
    expect(vectorProgress.map((event) => event.completed)).toEqual([1, 2]);

    expect(events.at(-1)).toMatchObject({ phase: "done", warningCount: 0 });
  });

  test("filters low-scoring tail results with minScore on rerank raw scores", async () => {
    const docC = store.upsertDocument({
      collection: "col",
      path: "/col/c.md",
      title: "Gamma",
      mtime: 1,
      hash: "hc",
    });
    const cC = store.insertChunk({
      doc_id: docC,
      chunk_idx: 0,
      content: "machine learning systems",
      heading_path: null,
      start_line: 0,
      end_line: 3,
      token_count: 3,
    });
    store.insertFTS(cC, "machine learning systems");

    const client = {
      embed: async () => null,
      expand: async () => null,
      rerank: async () => [
        { index: 1, score: 1 },
        { index: 0, score: 0.2 },
      ],
      healthCheck: async () => ({ embed: null, rerank: null, expand: null }),
    } as unknown as SeekxClient;

    const { results } = await hybridSearch(store, client, "machine", {
      mode: "bm25",
      useExpand: false,
      useRerank: true,
      minScore: 0.3,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.file).toBe("/col/c.md");
    expect(results[0]?.score).toBe(1);
  });

  test("filters low-scoring vector candidates with minScore on vector raw scores", async () => {
    const fakeVectorStore = {
      searchFTS: () => [] as RawResult[],
      searchVector: () =>
        [
          {
            chunk_id: 1,
            doc_id: 1,
            score: 0.82,
            content: "relevant vector match",
            path: "/col/a.md",
            title: "Alpha",
            collection: "col",
            start_line: 1,
            end_line: 3,
          },
          {
            chunk_id: 2,
            doc_id: 2,
            score: 0.12,
            content: "weak vector match",
            path: "/col/b.md",
            title: "Beta",
            collection: "col",
            start_line: 1,
            end_line: 3,
          },
        ] satisfies RawResult[],
      encodeDocid: (docId: number) => String(docId).padStart(6, "0"),
    } as unknown as Store;

    const client = {
      embed: async () => [[1, 0, 0]],
      expand: async () => null,
      rerank: async () => null,
      healthCheck: async () => ({ embed: null, rerank: null, expand: null }),
    } as unknown as SeekxClient;

    const { results } = await hybridSearch(fakeVectorStore, client, "nomatch", {
      mode: "vector",
      useExpand: false,
      useRerank: false,
      minScore: 0.3,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.file).toBe("/col/a.md");
    expect(results[0]?.score).toBe(1);
  });
});
