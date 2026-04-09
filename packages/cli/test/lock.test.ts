import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWatchLock, releaseWatchLock, watchPid } from "../src/lock.ts";

let tempDir: string;
let dbPath: string;
let lockFile: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `seekx-lock-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  dbPath = join(tempDir, "index.sqlite");
  lockFile = join(tempDir, "watch.lock");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("acquireWatchLock", () => {
  test("creates lock file containing current PID when no lock exists", () => {
    acquireWatchLock(dbPath);

    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(process.pid));
  });

  test("exits with USER_ERROR when a lock held by an alive process exists", () => {
    // Write the current process PID — it is definitely alive.
    writeFileSync(lockFile, String(process.pid), "utf-8");

    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    expect(() => acquireWatchLock(dbPath)).toThrow();

    const calls = exitSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // EXIT.USER_ERROR === 3
    expect(calls[0]?.[0]).toBe(3);

    exitSpy.mockRestore();
  });

  test("reclaims a stale lock whose PID no longer exists", () => {
    // Use a very large PID that almost certainly does not correspond to a
    // running process. On Linux the max PID is 4194304; on macOS 99998.
    const deadPid = 9999999;
    writeFileSync(lockFile, String(deadPid), "utf-8");

    // Should not throw — stale lock is reclaimed.
    acquireWatchLock(dbPath);

    expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(process.pid));
  });

  test("reclaims a lock file with non-numeric content (corrupted lock)", () => {
    writeFileSync(lockFile, "not-a-pid", "utf-8");

    acquireWatchLock(dbPath);

    expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(process.pid));
  });
});

describe("watchPid", () => {
  test("returns null when no lock file exists", () => {
    expect(watchPid(dbPath)).toBeNull();
  });

  test("returns the PID when a live process owns the lock", () => {
    // Write the current process PID — it is definitely alive.
    writeFileSync(lockFile, String(process.pid), "utf-8");
    expect(watchPid(dbPath)).toBe(process.pid);
  });

  test("returns null when the lock file records a dead PID", () => {
    const deadPid = 9999999;
    writeFileSync(lockFile, String(deadPid), "utf-8");
    expect(watchPid(dbPath)).toBeNull();
  });

  test("returns null when the lock file is corrupted", () => {
    writeFileSync(lockFile, "not-a-pid", "utf-8");
    expect(watchPid(dbPath)).toBeNull();
  });

  test("reflects live PID after acquireWatchLock", () => {
    acquireWatchLock(dbPath);
    expect(watchPid(dbPath)).toBe(process.pid);
  });

  test("returns null after releaseWatchLock removes the file", () => {
    acquireWatchLock(dbPath);
    releaseWatchLock(dbPath);
    expect(watchPid(dbPath)).toBeNull();
  });
});

describe("releaseWatchLock", () => {
  test("removes the lock file", () => {
    acquireWatchLock(dbPath);
    expect(existsSync(lockFile)).toBe(true);

    releaseWatchLock(dbPath);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("does not throw when lock file does not exist", () => {
    expect(() => releaseWatchLock(dbPath)).not.toThrow();
  });

  test("is idempotent — safe to call twice", () => {
    acquireWatchLock(dbPath);
    releaseWatchLock(dbPath);
    expect(() => releaseWatchLock(dbPath)).not.toThrow();
  });
});
