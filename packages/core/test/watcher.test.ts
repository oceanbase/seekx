import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
