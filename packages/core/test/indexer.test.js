/**
 * indexer.test.ts — Integration tests for the indexing pipeline.
 *
 * Uses real in-memory SQLite but stubs the embed client (no network calls).
 * Validates the mtime→hash two-level change detection logic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { indexFile } from "../src/indexer.ts";
import { Store } from "../src/store.ts";
// ---------------------------------------------------------------------------
// Embed stub — always returns null (no embedding, BM25-only mode)
// ---------------------------------------------------------------------------
const NULL_CLIENT = null;
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let db;
let store;
let tmpDir;
beforeEach(async () => {
    db = await openDatabase(":memory:");
    store = new Store(db, false);
    tmpDir = join(tmpdir(), `seekx-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    store.addCollection({ name: "test", path: tmpDir });
});
afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
});
function writeDoc(name, content) {
    const p = join(tmpDir, name);
    writeFileSync(p, content, "utf-8");
    return p;
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("indexFile — new file", () => {
    test("returns status=indexed for a new .md file", async () => {
        const p = writeDoc("a.md", "# Hello\n\nWorld");
        const result = await indexFile(store, NULL_CLIENT, "test", p);
        expect(result.status).toBe("indexed");
        expect(result.chunkCount).toBeGreaterThan(0);
    });
    test("creates chunks in store", async () => {
        const p = writeDoc("b.md", "# Title\n\nSome content here.");
        await indexFile(store, NULL_CLIENT, "test", p);
        const doc = store.findDocumentByPath("test", p);
        expect(doc).not.toBeNull();
        const chunks = store.getChunksByDocId(doc.id);
        expect(chunks.length).toBeGreaterThan(0);
    });
    test("skips unsupported file extensions", async () => {
        const p = writeDoc("image.png", "binary");
        const result = await indexFile(store, NULL_CLIENT, "test", p);
        expect(result.status).toBe("skipped");
    });
});
describe("indexFile — change detection (mtime)", () => {
    test("second index of same content → skipped (mtime unchanged)", async () => {
        const p = writeDoc("c.md", "# Same\n\nContent");
        await indexFile(store, NULL_CLIENT, "test", p);
        // Second call: mtime hasn't changed, should skip.
        const result = await indexFile(store, NULL_CLIENT, "test", p);
        expect(result.status).toBe("skipped");
    });
});
describe("indexFile — change detection (hash)", () => {
    test("content change → re-indexed", async () => {
        const p = writeDoc("d.md", "# Version 1\n\nOriginal content.");
        await indexFile(store, NULL_CLIENT, "test", p);
        // Simulate content change with explicit mtime bump by re-writing.
        // We need to trick the mtime check: write new content and then set a
        // future mtime by manipulating the stored mtime.
        const doc = store.findDocumentByPath("test", p);
        if (doc)
            store.updateDocumentMtime(doc.id, 0); // reset stored mtime to force level-2 check
        writeFileSync(p, "# Version 2\n\nChanged content.", "utf-8");
        const result = await indexFile(store, NULL_CLIENT, "test", p);
        expect(result.status).toBe("indexed");
        // Old chunks should be replaced with new ones.
        const doc2 = store.findDocumentByPath("test", p);
        const chunks = store.getChunksByDocId(doc2.id);
        expect(chunks.some((c) => c.content.includes("Version 2"))).toBe(true);
    });
});
describe("indexFile — plain text", () => {
    test("indexes .txt files", async () => {
        const p = writeDoc("notes.txt", "Line one.\n\nLine two.\n\nLine three.");
        const result = await indexFile(store, NULL_CLIENT, "test", p);
        expect(result.status).toBe("indexed");
    });
});
//# sourceMappingURL=indexer.test.js.map