import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import type { Database } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { Watcher, type WatcherEvent } from "../src/watcher.ts";

let db: Database;
let store: Store;
let tempRoot: string;
let docsPath: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  store = new Store(db, false);
  tempRoot = join(
    tmpdir(),
    `seekx-watcher-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  docsPath = join(tempRoot, "docs");
  mkdirSync(docsPath, { recursive: true });
  store.addCollection({ name: "docs", path: docsPath });
});

afterEach(() => {
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

function waitForEvent(
  watcher: Watcher,
  predicate: (event: WatcherEvent) => boolean,
  timeoutMs = 5000,
): Promise<WatcherEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for watcher event"));
    }, timeoutMs);

    watcher.on("event", (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      resolve(event);
    });
  });
}

function waitForEvents(
  watcher: Watcher,
  predicate: (event: WatcherEvent) => boolean,
  count: number,
  timeoutMs = 5000,
): Promise<WatcherEvent[]> {
  return new Promise((resolve, reject) => {
    const collected: WatcherEvent[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out: collected ${collected.length}/${count} events`));
    }, timeoutMs);

    watcher.on("event", (event) => {
      if (!predicate(event)) return;
      collected.push(event);
      if (collected.length >= count) {
        clearTimeout(timer);
        resolve(collected);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers for syncCollections tests
// ---------------------------------------------------------------------------

/**
 * Collect all "event" emissions from a watcher into an array.
 * Returns a cleanup function that removes the listener.
 */
function collectEvents(watcher: Watcher): { events: WatcherEvent[]; stop: () => void } {
  const events: WatcherEvent[] = [];
  const handler = (e: WatcherEvent) => events.push(e);
  watcher.on("event", handler);
  return { events, stop: () => watcher.off("event", handler) };
}

describe("Watcher.syncCollections()", () => {
  test("emits collection_added and starts watching when a new collection appears in DB", async () => {
    // Watcher starts with only "docs"; "notes" is added to the store later.
    const notesPath = join(tempRoot, "notes");
    mkdirSync(notesPath, { recursive: true });

    const watcher = new Watcher(store, null, [{ collection: "docs", rootPath: docsPath }], {
      debounceMs: 25,
      syncIntervalMs: 2000,
    });
    const driver = watcher as unknown as { syncCollections(): void };
    const { events, stop } = collectEvents(watcher);

    try {
      // Register "notes" in the DB — the watcher hasn't seen it yet.
      store.addCollection({ name: "notes", path: notesPath });

      driver.syncCollections();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "collection_added", collection: "notes" });

      // A file written to the new collection should now be indexable via
      // handleChange, confirming chokidar (simulated via driver) routes correctly.
      const driver2 = watcher as unknown as { handleChange(path: string): void };
      const notePath = join(notesPath, "hello.md");
      writeFileSync(notePath, "# Hello\n\nNotes collection.\n", "utf-8");

      const indexedPromise = new Promise<WatcherEvent>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 3000);
        watcher.on("event", (e) => {
          if (e.type === "indexed" && e.result.path === notePath) {
            clearTimeout(t);
            resolve(e);
          }
        });
      });

      driver2.handleChange(notePath);
      const indexed = await indexedPromise;
      expect(indexed.type).toBe("indexed");
    } finally {
      stop();
      await watcher.stop();
    }
  });

  test("emits collection_removed, cancels debounce timers, and stops watching when a collection disappears from DB", () => {
    // Watcher starts watching both "docs" and "notes"; "notes" is then removed.
    const notesPath = join(tempRoot, "notes");
    mkdirSync(notesPath, { recursive: true });
    store.addCollection({ name: "notes", path: notesPath });

    const watcher = new Watcher(
      store,
      null,
      [
        { collection: "docs", rootPath: docsPath },
        { collection: "notes", rootPath: notesPath },
      ],
      { debounceMs: 60000, syncIntervalMs: 2000 }, // very long debounce so timer stays alive
    );

    // Access internal state to plant a debounce timer simulating a pending change.
    const internal = watcher as unknown as {
      debounceMap: Map<string, ReturnType<typeof setTimeout>>;
      pendingSet: Set<string>;
      syncCollections(): void;
    };

    const pendingNotesPath = join(notesPath, "pending.md");
    // Plant a fake timer — we just need to verify it is cancelled.
    const fakeTimer = setTimeout(() => {}, 60000);
    internal.debounceMap.set(pendingNotesPath, fakeTimer);
    // Plant a pendingSet entry for the same path.
    internal.pendingSet.add(pendingNotesPath);

    const { events, stop } = collectEvents(watcher);

    try {
      store.removeCollection("notes");
      internal.syncCollections();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "collection_removed", collection: "notes" });

      // Debounce timer for the notes path must be cleared.
      expect(internal.debounceMap.has(pendingNotesPath)).toBe(false);
      // pendingSet entry must be cleared so no re-queue happens after any
      // hypothetical in-flight indexFile() completes.
      expect(internal.pendingSet.has(pendingNotesPath)).toBe(false);

      // The docs collection must remain intact.
      const collectionsField = (watcher as unknown as { collections: { collection: string }[] })
        .collections;
      expect(collectionsField.map((c) => c.collection)).toEqual(["docs"]);
    } finally {
      clearTimeout(fakeTimer); // in case syncCollections didn't clear it (test would still pass)
      stop();
      watcher.stop();
    }
  });

  test("no events emitted when collection set is unchanged", () => {
    const watcher = new Watcher(store, null, [{ collection: "docs", rootPath: docsPath }], {
      debounceMs: 25,
      syncIntervalMs: 2000,
    });
    const driver = watcher as unknown as { syncCollections(): void };
    const { events, stop } = collectEvents(watcher);

    try {
      // DB already has "docs" (added in beforeEach); calling sync should be a no-op.
      driver.syncCollections();
      expect(events).toHaveLength(0);
    } finally {
      stop();
      watcher.stop();
    }
  });

  test("inProgressSet is NOT cleared when collection is removed (prevents concurrent indexFile race)", () => {
    // This test validates the invariant: removing a collection from the DB must
    // not remove its paths from inProgressSet, because doing so would allow a
    // concurrent debounce to call runIndex() again while the original async
    // indexFile() is still awaiting, creating two writers on the same rows.
    const notesPath = join(tempRoot, "notes");
    mkdirSync(notesPath, { recursive: true });
    store.addCollection({ name: "notes", path: notesPath });

    const watcher = new Watcher(
      store,
      null,
      [
        { collection: "docs", rootPath: docsPath },
        { collection: "notes", rootPath: notesPath },
      ],
      { debounceMs: 25, syncIntervalMs: 2000 },
    );

    const internal = watcher as unknown as {
      inProgressSet: Set<string>;
      syncCollections(): void;
    };

    const inFlightPath = resolve(join(notesPath, "inflight.md"));
    internal.inProgressSet.add(inFlightPath);

    const { stop } = collectEvents(watcher);

    try {
      store.removeCollection("notes");
      internal.syncCollections();

      // inProgressSet must still contain the in-flight path.
      expect(internal.inProgressSet.has(inFlightPath)).toBe(true);
    } finally {
      stop();
      watcher.stop();
    }
  });
});

describe("Watcher", () => {
  test("indexes files and removes documents through watcher event handlers", async () => {
    const watcher = new Watcher(store, null, [{ collection: "docs", rootPath: docsPath }], {
      debounceMs: 25,
      ignore: [],
    });
    const driver = watcher as unknown as {
      handleChange(path: string): void;
      handleUnlink(path: string): void;
    };

    try {
      const notePath = join(docsPath, "note.md");
      const indexedEventPromise = waitForEvent(
        watcher,
        (event) => event.type === "indexed" && event.result.path === notePath,
      );

      writeFileSync(notePath, "# Note\n\nWatcher indexed this file.\n", "utf-8");
      driver.handleChange(notePath);

      const indexedEvent = await indexedEventPromise;
      expect(indexedEvent.type).toBe("indexed");
      if (indexedEvent.type !== "indexed") throw new Error("Expected indexed watcher event");
      expect(indexedEvent.result.status).toBe("indexed");

      const indexedDoc = store.findDocumentByPath("docs", notePath);
      expect(indexedDoc).not.toBeNull();

      const removedEventPromise = waitForEvent(
        watcher,
        (event) => event.type === "removed" && event.path === notePath,
      );

      rmSync(notePath);
      driver.handleUnlink(notePath);

      const removedEvent = await removedEventPromise;
      expect(removedEvent).toEqual({ type: "removed", path: notePath });
      expect(store.findDocumentByPath("docs", notePath)).toBeNull();
    } finally {
      await watcher.stop();
    }
  });

  test("sequential changes are both indexed and final DB state matches last write", async () => {
    // This test triggers two handleChange calls for the same file with a gap
    // that lets the first debounce fire before the second arrives.  In the
    // buggy implementation the two concurrent indexFile() calls would race on
    // the same SQLite rows; the serialisation guard introduced in the fix
    // ensures the second runs only after the first finishes, so the final DB
    // document reflects the second write.
    const notePath = join(docsPath, "sequential.md");
    writeFileSync(notePath, "# Version one\n", "utf-8");

    const watcher = new Watcher(store, null, [{ collection: "docs", rootPath: docsPath }], {
      debounceMs: 20,
    });
    const driver = watcher as unknown as {
      handleChange(path: string): void;
    };

    try {
      // We expect exactly two "indexed" events for this file.
      const eventsPromise = waitForEvents(
        watcher,
        (e) => e.type === "indexed" && "result" in e && e.result.path === notePath,
        2,
        6000,
      );

      // First change: trigger debounce, let it fire.
      driver.handleChange(notePath);
      await Bun.sleep(60); // enough for debounce (20 ms) to fire + indexFile to start

      // Second change: overwrite file content, trigger another debounce.
      writeFileSync(notePath, "# Version two\n\nAdded content here.\n", "utf-8");
      driver.handleChange(notePath);

      // Wait for both indexed events.
      const events = await eventsPromise;
      expect(events).toHaveLength(2);
      for (const e of events) {
        if (e.type !== "indexed") throw new Error("Expected indexed event");
        expect(["indexed", "mtime_only", "skipped"]).toContain(e.result.status);
      }

      // The document in the DB should reflect the second write.
      const doc = store.findDocumentByPath("docs", notePath);
      expect(doc).not.toBeNull();

      // FTS should contain "Version two" from the second write.
      const results = store.searchFTS('"Version two"', 5, ["docs"]);
      expect(results.length).toBeGreaterThan(0);
    } finally {
      await watcher.stop();
    }
  });
});
