/**
 * store.test.ts — Unit tests for Store using an in-memory SQLite database.
 *
 * We can't use bun:sqlite directly (dynamic import in db.ts), so we let
 * Store accept a Database-like interface and use the real db.ts openDatabase.
 * Tests run without sqlite-vec (vecLoaded = false).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Store } from "../src/store.ts";
let db;
let store;
beforeEach(async () => {
    // Use :memory: for isolation
    db = await openDatabase(":memory:");
    store = new Store(db, false);
});
afterEach(async () => {
    db.close();
});
describe("Collection CRUD", () => {
    test("addCollection and getCollection", () => {
        store.addCollection({ name: "notes", path: "/home/user/notes", description: "My notes" });
        const col = store.getCollection("notes");
        expect(col).not.toBeNull();
        expect(col.path).toBe("/home/user/notes");
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
        expect(cols[0].path).toBe("/home/user/notes-v2");
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
        store.insertChunk({ doc_id: docId, chunk_idx: 0, content: "hello world", heading_path: null, start_line: 0, end_line: 1, token_count: 2 });
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
        store.upsertDocument({ collection: "docs", path: "/docs/a.md", title: "A", mtime: 999, hash: "xyz" });
        const doc = store.findDocumentByPath("docs", "/docs/a.md");
        expect(doc).not.toBeNull();
        expect(doc.mtime).toBe(999);
        expect(doc.hash).toBe("xyz");
    });
    test("updateDocumentMtime updates only mtime", () => {
        const id = store.upsertDocument({ collection: "docs", path: "/docs/b.md", title: "B", mtime: 1, hash: "h1" });
        store.updateDocumentMtime(id, 9999);
        const doc = store.findDocumentByPath("docs", "/docs/b.md");
        expect(doc.mtime).toBe(9999);
        expect(doc.hash).toBe("h1");
    });
    test("deleteDocument removes chunks via cascade", () => {
        const docId = store.upsertDocument({ collection: "docs", path: "/docs/c.md", title: "C", mtime: 1, hash: "h2" });
        const chunkId = store.insertChunk({ doc_id: docId, chunk_idx: 0, content: "text", heading_path: null, start_line: 0, end_line: 1, token_count: 1 });
        store.insertFTS(chunkId, "text");
        store.deleteDocument(docId);
        const doc = store.findDocumentByPath("docs", "/docs/c.md");
        expect(doc).toBeNull();
    });
});
describe("FTS search", () => {
    beforeEach(() => {
        store.addCollection({ name: "col", path: "/col" });
        const docId = store.upsertDocument({ collection: "col", path: "/col/x.md", title: "X", mtime: 1, hash: "h" });
        const chunkId = store.insertChunk({ doc_id: docId, chunk_idx: 0, content: "向量数据库 vector database", heading_path: null, start_line: 0, end_line: 5, token_count: 10 });
        store.insertFTS(chunkId, "向量数据库 vector database 向量 数据库");
    });
    test("searchFTS finds a match", () => {
        const results = store.searchFTS('"vector"', 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain("vector");
    });
    test("searchFTS with unknown term returns empty", () => {
        const results = store.searchFTS('"zzznomatch"', 10);
        expect(results.length).toBe(0);
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
//# sourceMappingURL=store.test.js.map