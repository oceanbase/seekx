/**
 * db.ts — Bun SQLite adapter with sqlite-vec extension support.
 *
 * On macOS, Bun uses the system SQLite compiled with SQLITE_OMIT_LOAD_EXTENSION,
 * which prevents loading native extensions like sqlite-vec. We swap in Homebrew's
 * full-featured SQLite via setCustomSQLite() before any database is opened.
 *
 * SEEKX_SQLITE_PATH env var overrides the Homebrew path for CI / custom builds.
 *
 * loadSqliteVec() returns false (never throws) when the extension is unavailable;
 * callers degrade to BM25-only mode.
 */

// Dynamic import string prevents tsc from resolving "bun:sqlite" in non-Bun builds.
const bunSqlite = "bun:sqlite";
const { Database: BunDatabase } = await import(/* @vite-ignore */ bunSqlite as "bun:sqlite");

if (process.platform === "darwin") {
  const customPath = process.env["SEEKX_SQLITE_PATH"];
  const candidates = [
    customPath,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon Homebrew
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Intel Homebrew
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
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
