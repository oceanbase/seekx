/**
 * utils.ts — CLI helpers: store initialization, error handling, exit codes.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadSqliteVec, openDatabase, requireConfig, SeekxClient, Store, isEmbedConfigured } from "@seekx/core";
import type { Database, ResolvedConfig } from "@seekx/core";

// ---------------------------------------------------------------------------
// Exit codes (see docs/cli-design.md §Exit Codes)
// ---------------------------------------------------------------------------

export const EXIT = {
  OK: 0,
  NO_RESULTS: 1,
  API_DEGRADED: 2,
  USER_ERROR: 3,
  INTERNAL_ERROR: 4,
} as const;

// ---------------------------------------------------------------------------
// App context
// ---------------------------------------------------------------------------

export interface AppContext {
  cfg: ResolvedConfig;
  db: Database;
  store: Store;
  client: SeekxClient | null;
  vecLoaded: boolean;
}

/**
 * Open the store and build the AppContext used by most commands.
 * Exits with EXIT.INTERNAL_ERROR on fatal failures.
 */
export async function openContext(opts: { json?: boolean } = {}): Promise<AppContext> {
  let cfg: ResolvedConfig;
  try {
    cfg = requireConfig();
  } catch (e) {
    die(String(e), EXIT.INTERNAL_ERROR, opts.json);
  }

  const dbDir = dirname(cfg!.dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  let db: Database;
  try {
    db = await openDatabase(cfg!.dbPath);
  } catch (e) {
    die(`Failed to open database: ${e}`, EXIT.INTERNAL_ERROR, opts.json);
  }

  const vecLoaded = await loadSqliteVec(db!);
  const store = new Store(db!, vecLoaded);

  const client = isEmbedConfigured(cfg!)
    ? new SeekxClient(cfg!.embed, cfg!.rerank, cfg!.expand)
    : null;

  return { cfg: cfg!, db: db!, store, client, vecLoaded };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function die(msg: string, code = EXIT.INTERNAL_ERROR, asJson?: boolean): never {
  if (asJson) {
    printJson({ error: msg });
  } else {
    console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  }
  process.exit(code);
}

export function warn(msg: string): void {
  console.error(`\x1b[33mwarn:\x1b[0m ${msg}`);
}
