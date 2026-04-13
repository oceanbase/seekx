/**
 * store.test.ts — Unit tests for Store using an in-memory SQLite database.
 *
 * Uses the real db.ts openDatabase (better-sqlite3) for parity with production.
 * Tests run without sqlite-vec (vecLoaded = false).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import type { Database } from "../src/db.ts";
import { Store } from "../src/store.ts";

let db: Database;
let store: Store;

beforeEach(async () => {
  // Use :memory: for isolation
  db = await openDatabase(":memory:");
  store = new Store(db, false);
});

afterEach(async () => {
  db.close();
});

describe("Database pragmas", () => {
  test("configures a busy timeout for write contention", () => {
    const row = db.prepare("PRAGMA busy_timeout").get() as {
      busy_timeout?: number;
      timeout?: number;
    } | null;
    expect(row?.busy_timeout ?? row?.timeout).toBe(5000);
  });
});

describe("Collection CRUD", () => {
  test("addCollection and getCollection", () => {
    store.addCollection({ name: "notes", path: "/home/user/notes", description: "My notes" });
    const col = store.getCollection("notes");
    expect(col).not.toBeNull();
    expect(col?.path).toBe("/home/user/notes");
  });

  test("listCollections returns all", () => {
    store.addCollection({ name: "a", path: "/a" });
    store.addCollection({ name: "b", path: "/b" });
    const cols = store.listCollections();
    expect(cols.map((c) => c.name)).toContain("a");
    expect(cols.map((c) => c.name)).toContain("b");
  });

  test("addCollection is idempotent (upsert)", () => {
    store.addCollection({ name: "notes", path: "/home/user/notes" });
    store.addCollection({ name: "notes", path: "/home/user/notes-v2" });
    const cols = store.listCollections().filter((c) => c.name === "notes");
    expect(cols.length).toBe(1);
    expect(cols[0]?.path).toBe("/home/user/notes-v2");
  });

  test("removeCollection cascades documents", () => {
    store.addCollection({ name: "notes", path: "/notes" });
    const docId = store.upsertDocument({
      collection: "notes",
      path: "/notes/a.md",
      title: "A",
      mtime: 100,
      hash: "aaa",
    });
    store.insertChunk({
      doc_id: docId,
      chunk_idx: 0,
      content: "hello world",
      heading_path: null,
      start_line: 0,
      end_line: 1,
      token_count: 2,
    });
    store.removeCollection("notes");
    const col = store.getCollection("notes");
    expect(col).toBeNull();
    const doc = store.findDocumentByPath("notes", "/notes/a.md");
    expect(doc).toBeNull();
  });
});

describe("Document CRUD", () => {
  beforeEach(() => {
    store.addCollection({ name: "docs", path: "/docs" });
  });

  test("upsertDocument creates and returns id", () => {
    const id = store.upsertDocument({
      collection: "docs",
      path: "/docs/a.md",
      title: "A",
      mtime: 1000,
      hash: "abc",
    });
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  test("findDocumentByPath returns stored mtime and hash", () => {
    store.upsertDocument({
      collection: "docs",
      path: "/docs/a.md",
      title: "A",
      mtime: 999,
      hash: "xyz",
    });
    const doc = store.findDocumentByPath("docs", "/docs/a.md");
    expect(doc).not.toBeNull();
    expect(doc?.mtime).toBe(999);
    expect(doc?.hash).toBe("xyz");
  });

  test("updateDocumentMtime updates only mtime", () => {
    const id = store.upsertDocument({
      collection: "docs",
      path: "/docs/b.md",
      title: "B",
      mtime: 1,
      hash: "h1",
    });
    store.updateDocumentMtime(id, 9999);
    const doc = store.findDocumentByPath("docs", "/docs/b.md");
    expect(doc?.mtime).toBe(9999);
    expect(doc?.hash).toBe("h1");
  });

  test("deleteDocument removes chunks via cascade", () => {
    const docId = store.upsertDocument({
      collection: "docs",
      path: "/docs/c.md",
      title: "C",
      mtime: 1,
      hash: "h2",
    });
    const chunkId = store.insertChunk({
      doc_id: docId,
      chunk_idx: 0,
      content: "text",
      heading_path: null,
      start_line: 0,
      end_line: 1,
      token_count: 1,
    });
    store.insertFTS(chunkId, "text");
    store.deleteDocument(docId);
    const doc = store.findDocumentByPath("docs", "/docs/c.md");
    expect(doc).toBeNull();
  });
});

describe("FTS search", () => {
  beforeEach(() => {
    store.addCollection({ name: "col", path: "/col" });
    const docId = store.upsertDocument({
      collection: "col",
      path: "/col/x.md",
      title: "X",
      mtime: 1,
      hash: "h",
    });
    const chunkId = store.insertChunk({
      doc_id: docId,
      chunk_idx: 0,
      content: "向量数据库 vector database",
      heading_path: null,
      start_line: 0,
      end_line: 5,
      token_count: 10,
    });
    store.insertFTS(chunkId, "向量数据库 vector database 向量 数据库");
  });

  test("searchFTS finds a match", () => {
    const results = store.searchFTS('"vector"', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain("vector");
  });

  test("searchFTS with unknown term returns empty", () => {
    const results = store.searchFTS('"zzznomatch"', 10);
    expect(results.length).toBe(0);
  });
});

describe("vec_chunks cleanup on document deletion", () => {
  // Uses a regular table named vec_chunks (not sqlite-vec virtual table) to
  // verify that _deleteChunkDerivedData deletes embeddings without needing
  // the sqlite-vec extension to be present at test time.
  test("deleteDocument removes vec_chunks rows for every chunk", async () => {
    // Bootstrap: use a vecLoaded=false store to run migrations and seed data.
    const seedStore = new Store(db, false);
    seedStore.addCollection({ name: "vc", path: "/vc" });
    const docId = seedStore.upsertDocument({
      collection: "vc",
      path: "/vc/doc.md",
      title: "D",
      mtime: 1,
      hash: "hD",
    });
    const chunkId = seedStore.insertChunk({
      doc_id: docId,
      chunk_idx: 0,
      content: "content",
      heading_path: null,
      start_line: 0,
      end_line: 1,
      token_count: 1,
    });
    seedStore.insertFTS(chunkId, "content");
    // Simulate stored embed_dim and a fake vec_chunks table (plain table, no vec0).
    seedStore.setMeta("embed_dim", "3");
    db.exec("CREATE TABLE IF NOT EXISTS vec_chunks (chunk_id INTEGER PRIMARY KEY)");
    db.exec(`INSERT INTO vec_chunks(chunk_id) VALUES (${chunkId})`);

    // Create a vecLoaded=true store on the same database. The constructor reads
    // embed_dim from meta so vecDim becomes 3, enabling vec cleanup.
    const vecStore = new Store(db, true);
    const before = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(before.n).toBe(1);

    vecStore.deleteDocument(docId);

    const after = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(after.n).toBe(0);
  });

  test("removeCollection removes vec_chunks rows for all its documents", async () => {
    const seedStore = new Store(db, false);
    seedStore.addCollection({ name: "vc2", path: "/vc2" });
    const docId = seedStore.upsertDocument({
      collection: "vc2",
      path: "/vc2/doc.md",
      title: "E",
      mtime: 1,
      hash: "hE",
    });
    const chunkId = seedStore.insertChunk({
      doc_id: docId,
      chunk_idx: 0,
      content: "some text",
      heading_path: null,
      start_line: 0,
      end_line: 1,
      token_count: 2,
    });
    seedStore.insertFTS(chunkId, "some text");
    seedStore.setMeta("embed_dim", "3");
    db.exec("CREATE TABLE IF NOT EXISTS vec_chunks (chunk_id INTEGER PRIMARY KEY)");
    db.exec(`INSERT OR IGNORE INTO vec_chunks(chunk_id) VALUES (${chunkId})`);

    const vecStore = new Store(db, true);
    const before = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(before.n).toBeGreaterThan(0);

    vecStore.removeCollection("vc2");

    const after = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(after.n).toBe(0);
  });
});

describe("getStatus", () => {
  test("sqliteVecLoaded follows vecLoaded; vectorSearchAvailable needs embed_dim", async () => {
    const d = await openDatabase(":memory:");
    try {
      let s = new Store(d, false);
      let st = s.getStatus();
      expect(st.sqliteVecLoaded).toBe(false);
      expect(st.vectorSearchAvailable).toBe(false);

      s = new Store(d, true);
      st = s.getStatus();
      expect(st.sqliteVecLoaded).toBe(true);
      expect(st.vectorSearchAvailable).toBe(false);

      s.setMeta("embed_dim", "384");
      s = new Store(d, true);
      st = s.getStatus();
      expect(st.sqliteVecLoaded).toBe(true);
      expect(st.vectorSearchAvailable).toBe(true);
    } finally {
      d.close();
    }
  });
});

describe("Meta KV", () => {
  test("setMeta and getMeta", () => {
    store.setMeta("version", "1");
    expect(store.getMeta("version")).toBe("1");
  });

  test("getMeta returns null for unknown key", () => {
    expect(store.getMeta("no_such_key")).toBeNull();
  });
});
