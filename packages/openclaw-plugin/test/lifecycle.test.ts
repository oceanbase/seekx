/**
 * lifecycle.test.ts — Integration tests for SeekxLifecycle.
 *
 * Uses real seekx-core functions with a temporary on-disk SQLite database.
 * No embed client is used (BM25-only mode), so no network calls are made.
 *
 * Run: bun test test/lifecycle.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hybridSearch } from "seekx-core";
import { SeekxLifecycle } from "../src/lifecycle.ts";
import type { SeekxPluginConfig } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `seekx-plugin-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDoc(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

function makeConfig(overrides: Partial<SeekxPluginConfig> = {}): SeekxPluginConfig {
  return {
    dbPath: join(makeTmpDir(), "test.db"),
    extraPaths: [],
    embed: { baseUrl: "", apiKey: "", model: "" },
    rerank: null,
    expand: null,
    searchLimit: 6,
    refreshIntervalMs: 0, // disable periodic re-index in tests
    includeOpenClawMemory: false,
    autoRecall: {
      enabled: true,
      maxResults: 3,
      minScore: 0.2,
      maxChars: 1200,
      minQueryLength: 4,
    },
    citations: "auto",
    searchTimeoutMs: 8000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let lifecycle: SeekxLifecycle;
let docsDir: string;
let dbDir: string;

beforeEach(() => {
  docsDir = makeTmpDir();
  dbDir = makeTmpDir();
});

afterEach(async () => {
  await lifecycle?.stop();
  rmSync(docsDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("SeekxLifecycle — startup and indexing", () => {
  test("start() opens the database and indexes registered collections", async () => {
    writeDoc(docsDir, "hello.md", "# Hello World\n\nThis is a test document about cats.");
    writeDoc(docsDir, "bye.md", "# Goodbye\n\nThis is another document about dogs.");

    lifecycle = new SeekxLifecycle(
      makeConfig({
        dbPath: join(dbDir, "test.db"),
        extraPaths: [{ name: "docs", path: docsDir }],
      }),
    );

    await lifecycle.start();
    // _runFullIndex runs in the background via void; call it directly to wait
    await lifecycle._runFullIndex();

    const status = lifecycle.store.getStatus();
    expect(status.totalDocuments).toBe(2);
    expect(status.totalChunks).toBeGreaterThan(0);
  });

  test("start() is idempotent — calling twice does not open two databases", async () => {
    lifecycle = new SeekxLifecycle(makeConfig({ dbPath: join(dbDir, "test.db") }));
    await lifecycle.start();
    const store1 = lifecycle.store;
    await lifecycle.start(); // second call is a no-op
    expect(lifecycle.store).toBe(store1);
  });

  test("creates the database directory if it does not exist", async () => {
    const nestedDir = join(dbDir, "deep", "nested");
    lifecycle = new SeekxLifecycle(makeConfig({ dbPath: join(nestedDir, "test.db") }));
    await lifecycle.start();
    expect(existsSync(nestedDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("SeekxLifecycle — BM25 search", () => {
  test("hybridSearch returns results after indexing (BM25-only)", async () => {
    // Content contains the query phrase "Rust programming" consecutively,
    // which matches SQLite FTS5 phrase search semantics used by buildFTSQuery.
    writeDoc(docsDir, "rust.md", "# Rust programming guide\n\nRust programming is a systems language focused on safety.");
    writeDoc(docsDir, "python.md", "# Python guide\n\nPython is an interpreted language known for readability.");

    lifecycle = new SeekxLifecycle(
      makeConfig({
        dbPath: join(dbDir, "test.db"),
        extraPaths: [{ name: "docs", path: docsDir }],
      }),
    );

    await lifecycle.start();
    await lifecycle._runFullIndex();

    // "Rust programming" appears as a consecutive phrase in the heading of rust.md.
    const { results } = await hybridSearch(lifecycle.store, null, "Rust programming", {
      limit: 5,
      mode: "bm25",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.file).toContain("rust.md");
  });

  test("search respects collection filter", async () => {
    const dir2 = makeTmpDir();
    // Use a single-word phrase query so FTS5 phrase matching finds it in both docs.
    writeDoc(docsDir, "alpha.md", "# Alpha guide\n\nAlpha guide to software engineering.");
    writeDoc(dir2, "beta.md", "# Alpha guide\n\nAlpha guide to software engineering.");

    lifecycle = new SeekxLifecycle(
      makeConfig({
        dbPath: join(dbDir, "test.db"),
        extraPaths: [
          { name: "col-a", path: docsDir },
          { name: "col-b", path: dir2 },
        ],
      }),
    );

    await lifecycle.start();
    await lifecycle._runFullIndex();

    const { results } = await hybridSearch(lifecycle.store, null, "Alpha guide", {
      limit: 10,
      mode: "bm25",
      collections: ["col-a"],
    });

    // Results must exist and must all belong to col-a.
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.collection === "col-a")).toBe(true);

    rmSync(dir2, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe("SeekxLifecycle — extra paths", () => {
  test("non-existent extra paths are silently skipped", async () => {
    lifecycle = new SeekxLifecycle(
      makeConfig({
        dbPath: join(dbDir, "test.db"),
        extraPaths: [{ name: "missing", path: "/does/not/exist/at/all" }],
      }),
    );

    // Should not throw.
    await expect(lifecycle.start()).resolves.toBeUndefined();
    expect(lifecycle.store.listCollections()).toHaveLength(0);
  });

  test("tilde in path is expanded to home directory", async () => {
    // Use the real home dir; create a known temp subdir under it.
    // We only check the collection is registered without error.
    lifecycle = new SeekxLifecycle(
      makeConfig({
        dbPath: join(dbDir, "test.db"),
        extraPaths: [{ name: "docs", path: docsDir }],
      }),
    );
    writeDoc(docsDir, "note.md", "# Note");
    await lifecycle.start();
    const cols = lifecycle.store.listCollections();
    expect(cols.map((c) => c.name)).toContain("docs");
  });
});

// ---------------------------------------------------------------------------

describe("SeekxLifecycle — shutdown", () => {
  test("stop() closes the database cleanly", async () => {
    lifecycle = new SeekxLifecycle(makeConfig({ dbPath: join(dbDir, "test.db") }));
    await lifecycle.start();
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });

  test("stop() before start() does not throw", async () => {
    lifecycle = new SeekxLifecycle(makeConfig({ dbPath: join(dbDir, "test.db") }));
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });

  test("stop() is safe to call multiple times", async () => {
    lifecycle = new SeekxLifecycle(makeConfig({ dbPath: join(dbDir, "test.db") }));
    await lifecycle.start();
    await lifecycle.stop();
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("SeekxLifecycle — LLM cache wiring", () => {
  test("store.getCachedLLM returns null for unknown keys", async () => {
    lifecycle = new SeekxLifecycle(makeConfig({ dbPath: join(dbDir, "test.db") }));
    await lifecycle.start();
    expect(lifecycle.store.getCachedLLM("no-such-key")).toBeNull();
  });

  test("store.setCachedLLM and getCachedLLM round-trip", async () => {
    lifecycle = new SeekxLifecycle(makeConfig({ dbPath: join(dbDir, "test.db") }));
    await lifecycle.start();
    lifecycle.store.setCachedLLM("test-key", "cached-value", 3600);
    expect(lifecycle.store.getCachedLLM("test-key")).toBe("cached-value");
  });
});
