/**
 * utils.ts — CLI helpers: store initialization, error handling, exit codes.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import {
  SeekxClient,
  Store,
  isEmbedConfigured,
  loadSqliteVec,
  openDatabase,
  requireConfig,
} from "@seekx/core";
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

/**
 * Merge `--json` from the root `seekx` program and the active subcommand.
 *
 * Commander stores a trailing `--json` on the parent when both register the same
 * flag, leaving subcommand options without `json`.
 */
export function resolveJson(opts: { json?: boolean }, cmd: Command): boolean {
  if (opts.json) return true;
  for (let p: Command | undefined = cmd.parent ?? undefined; p; p = p.parent ?? undefined) {
    const j = (p.opts() as { json?: boolean }).json;
    if (j) return true;
  }
  return false;
}

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
export async function openContext(opts: { json?: boolean | undefined } = {}): Promise<AppContext> {
  const cfg = loadRequiredConfig(opts.json);

  const dbDir = dirname(cfg.dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = await openDatabaseOrDie(cfg.dbPath, opts.json);

  const vecLoaded = await loadSqliteVec(db);
  const store = new Store(db, vecLoaded);

  const client = isEmbedConfigured(cfg) ? new SeekxClient(cfg.embed, cfg.rerank, cfg.expand) : null;

  return { cfg, db, store, client, vecLoaded };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function die(
  msg: string,
  code: number = EXIT.INTERNAL_ERROR,
  asJson?: boolean | undefined,
): never {
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

function loadRequiredConfig(asJson?: boolean | undefined): ResolvedConfig {
  try {
    return requireConfig();
  } catch (e) {
    die(String(e), EXIT.INTERNAL_ERROR, asJson);
  }
}

async function openDatabaseOrDie(dbPath: string, asJson?: boolean | undefined): Promise<Database> {
  try {
    return await openDatabase(dbPath);
  } catch (e) {
    die(`Failed to open database: ${e}`, EXIT.INTERNAL_ERROR, asJson);
  }
}
