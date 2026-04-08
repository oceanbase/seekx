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
import { hybridSearch } from "../src/search.ts";
import { Store } from "../src/store.ts";

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
});
