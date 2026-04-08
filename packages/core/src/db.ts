/**
 * db.ts — Bun SQLite adapter with sqlite-vec extension support.
 *
 * On macOS, Bun uses the system SQLite compiled with SQLITE_OMIT_LOAD_EXTENSION,
 * which prevents loading native extensions like sqlite-vec. We swap in a
 * load-extension-capable SQLite via setCustomSQLite() before any database is
 * opened.
 *
 * We first honor SEEKX_SQLITE_PATH, then probe common Homebrew locations, then
 * ask Homebrew for its sqlite prefix. This keeps the happy path zero-config for
 * standard installs while preserving an explicit override for CI / custom
 * builds.
 *
 * loadSqliteVec() returns false (never throws) when the extension is unavailable;
 * callers degrade to BM25-only mode.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Dynamic import string prevents tsc from resolving "bun:sqlite" in non-Bun builds.
const bunSqlite = "bun:sqlite";
const { Database: BunDatabase } = await import(/* @vite-ignore */ bunSqlite as "bun:sqlite");

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

if (process.platform === "darwin") {
  for (const p of getDarwinSQLiteCandidates()) {
    try {
      BunDatabase.setCustomSQLite(p);
      break;
    } catch {
      // try next candidate
    }
  }
}

export type Database = import("bun:sqlite").Database;
export type Statement = ReturnType<Database["prepare"]>;

/** Open (or create) a SQLite database at the given absolute path. */
export function openDatabase(path: string): Database {
  return new BunDatabase(path) as Database;
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
