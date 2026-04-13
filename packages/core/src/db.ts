/**
 * db.ts — SQLite adapter with sqlite-vec extension support.
 *
 * - **Bun**: uses `bun:sqlite` with optional Homebrew SQLite on macOS so
 *   `loadExtension` works for sqlite-vec (see comments in `loadBunSqliteOnce`).
 * - **Node** (e.g. OpenClaw jiti): uses `better-sqlite3` because `bun:sqlite`
 *   is not available there.
 *
 * `openDatabase` is async so callers stay compatible across backends and so
 * `bun:sqlite` can be loaded lazily (no top-level await in this module).
 *
 * loadSqliteVec() returns false (never throws) when the extension is
 * unavailable; callers degrade to BM25-only mode.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

function isBunRuntime(): boolean {
  return typeof (process.versions as { bun?: string }).bun === "string";
}

type BunSqlite = typeof import("bun:sqlite");

/**
 * Lazily load `bun:sqlite` on first `openDatabase()` call under Bun.
 *
 * Top-level `await import("bun:sqlite")` breaks hosts that evaluate plugin
 * TypeScript in a non-async module wrapper (e.g. some OpenClaw / Node loaders),
 * producing `ReferenceError: await is not defined`.
 */
function loadBunSqliteOnce(): Promise<BunSqlite> {
  return import(/* @vite-ignore */ "bun:sqlite" as "bun:sqlite").then((mod) => {
    if (process.platform === "darwin") {
      for (const p of getDarwinSQLiteCandidates()) {
        try {
          mod.Database.setCustomSQLite(p);
          break;
        } catch {
          // try next candidate
        }
      }
    }
    return mod;
  });
}

let bunSqlitePromise: Promise<BunSqlite> | null = null;

function ensureBunSqlite(): Promise<BunSqlite> {
  bunSqlitePromise ??= loadBunSqliteOnce();
  return bunSqlitePromise;
}

type SpawnResult = { status: number | null; stdout: string };
type SpawnRunner = (command: string, args: string[]) => SpawnResult;

function defaultSpawnRunner(command: string, args: string[]): SpawnResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

export function detectHomebrewSqlitePrefix(run: SpawnRunner = defaultSpawnRunner): string | null {
  try {
    const result = run("brew", ["--prefix", "sqlite"]);
    if (result.status !== 0) return null;
    const prefix = result.stdout.trim();
    return prefix ? prefix : null;
  } catch {
    return null;
  }
}

export function getDarwinSQLiteCandidates(
  customPath = process.env.SEEKX_SQLITE_PATH,
  brewPrefix = detectHomebrewSqlitePrefix(),
): string[] {
  const candidates = [
    customPath,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon Homebrew
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Intel Homebrew
    brewPrefix ? join(brewPrefix, "lib", "libsqlite3.dylib") : null,
  ].filter((p): p is string => Boolean(p));

  return [...new Set(candidates)];
}

/**
 * Narrow DB surface used by Store. Bun and better-sqlite3 both satisfy this at
 * runtime; we avoid a `Database` union so `prepare()` stays callable under tsc.
 */
export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): SqliteRunResult;
  all(...params: unknown[]): unknown;
}

/** Open (or create) a SQLite database at the given absolute path. */
export async function openDatabase(path: string): Promise<Database> {
  if (isBunRuntime()) {
    const mod = await ensureBunSqlite();
    return new mod.Database(path) as unknown as Database;
  }
  return new BetterSqlite3(path) as unknown as Database;
}

/**
 * Load the sqlite-vec extension into an already-open database.
 *
 * Returns true on success, false when the extension or the required SQLite
 * build is unavailable. Callers should warn the user and disable vector search.
 */
export async function loadSqliteVec(db: Database): Promise<boolean> {
  try {
    const { getLoadablePath } = await import("sqlite-vec");
    const vecPath = getLoadablePath();
    (db as unknown as { loadExtension(p: string): void }).loadExtension(vecPath);
    return true;
  } catch {
    return false;
  }
}
