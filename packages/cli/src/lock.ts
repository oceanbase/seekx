/**
 * lock.ts — Single-instance lock for seekx watch.
 *
 * The lock file lives alongside the database:
 *   dirname(dbPath)/watch.lock
 *
 * It contains the PID of the running watch process as a plain decimal string.
 * On startup, acquireWatchLock() checks for a live process; a stale lock
 * (the recorded PID no longer exists) is automatically reclaimed.
 * On shutdown, releaseWatchLock() removes the file.
 *
 * Only seekx watch uses this lock. Other write commands (add, reindex, remove)
 * are intentionally not gated — they coexist safely with a running watcher via
 * SQLite WAL mode.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT, die } from "./utils.ts";

function lockPath(dbPath: string): string {
  return join(dirname(dbPath), "watch.lock");
}

function isProcessAlive(pid: number): boolean {
  try {
    // kill(pid, 0) does not send a real signal; it only checks process existence.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the watch singleton lock.
 *
 * Exits with EXIT.USER_ERROR if another watch process is already running.
 * Automatically reclaims a stale lock from a previously crashed process.
 */
export function acquireWatchLock(dbPath: string, asJson?: boolean): void {
  const path = lockPath(dbPath);

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);

    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      die(
        `seekx watch is already running (PID ${pid}). Only one instance is allowed per database.`,
        EXIT.USER_ERROR,
        asJson,
      );
    }
    // Stale lock — fall through and overwrite.
  }

  writeFileSync(path, String(process.pid), "utf-8");
}

/**
 * Return the PID of an actively running watch process, or null if no watch
 * daemon is running (or the lock file records a dead process).
 *
 * Unlike acquireWatchLock(), this is read-only and has no side effects.
 */
export function watchPid(dbPath: string): number | null {
  const path = lockPath(dbPath);
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf-8").trim();
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid)) return null;

  return isProcessAlive(pid) ? pid : null;
}

/**
 * Release the watch singleton lock.
 *
 * Silently ignores a missing lock file (e.g. after a double shutdown call).
 */
export function releaseWatchLock(dbPath: string): void {
  const path = lockPath(dbPath);
  try {
    rmSync(path);
  } catch {
    // Already removed or never created — safe to ignore.
  }
}
