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
});
