import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
};

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type BetterSqlite3Ctor = new (
  path: string,
  options?: {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  },
) => SqliteDatabase;

type BunSqliteCtor = new (
  path: string,
  options?: {
    readonly?: boolean;
    create?: boolean;
  },
) => {
  query(sql: string): SqliteStatement;
  close(): void;
};

export interface PersistedSeekxStatus {
  totalDocuments: number;
  totalChunks: number;
  embeddedChunks: number;
  vectorSearchAvailable: boolean;
  embedModel: string | null;
  collections: Array<{
    name: string;
    path: string;
    docCount: number;
    chunkCount: number;
  }>;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function readTableNames(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name?: unknown }>;
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
}

function readMetaValue(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: unknown } | null;
  return typeof row?.value === "string" ? row.value : null;
}

function isBunRuntime(): boolean {
  return typeof (process.versions as { bun?: string }).bun === "string";
}

function openReadonlyDatabase(dbPath: string): SqliteDatabase {
  if (isBunRuntime()) {
    const { Database } = require("bun:sqlite") as { Database: BunSqliteCtor };
    const db = new Database(dbPath, { readonly: true, create: false });
    return {
      prepare(sql: string) {
        return db.query(sql);
      },
      close() {
        db.close();
      },
    };
  }

  const coreRequire = createRequire(require.resolve("seekx-core"));
  const BetterSqlite3 = coreRequire("better-sqlite3") as BetterSqlite3Ctor;
  return new BetterSqlite3(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
}

/**
 * Read persisted seekx index status directly from SQLite without constructing
 * Store. This is used by short-lived OpenClaw CLI probes where lifecycle.start()
 * has not finished yet, but the gateway has already indexed content.
 */
export function readPersistedSeekxStatusSync(dbPath: string): PersistedSeekxStatus | null {
  if (!existsSync(dbPath)) return null;

  let db: SqliteDatabase | null = null;
  try {
    db = openReadonlyDatabase(dbPath);

    const tables = readTableNames(db);
    const hasCoreTables =
      tables.has("collections") && tables.has("documents") && tables.has("chunks");
    if (!hasCoreTables) return null;

    const totalDocuments = toNumber(
      (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n?: unknown } | null)?.n,
    );
    const totalChunks = toNumber(
      (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n?: unknown } | null)?.n,
    );

    let embeddedChunks = 0;
    if (tables.has("vec_chunks")) {
      try {
        embeddedChunks = toNumber(
          (db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n?: unknown } | null)?.n,
        );
      } catch {
        embeddedChunks = 0;
      }
    }

    const embedModel = tables.has("meta") ? readMetaValue(db, "embed_model") : null;
    const embedDim = tables.has("meta") ? readMetaValue(db, "embed_dim") : null;
    const vectorSearchAvailable = tables.has("vec_chunks") && embedDim !== null;

    const collections = db
      .prepare(
        `SELECT c.name, c.path,
                COUNT(DISTINCT d.id) AS doc_count,
                COUNT(ch.id) AS chunk_count
         FROM collections c
         LEFT JOIN documents d ON d.collection = c.name
         LEFT JOIN chunks ch ON ch.doc_id = d.id
         GROUP BY c.name
         ORDER BY c.name`,
      )
      .all() as Array<{
      name?: unknown;
      path?: unknown;
      doc_count?: unknown;
      chunk_count?: unknown;
    }>;

    return {
      totalDocuments,
      totalChunks,
      embeddedChunks,
      vectorSearchAvailable,
      embedModel,
      collections: collections.map((row) => ({
        name: typeof row.name === "string" ? row.name : "",
        path: typeof row.path === "string" ? row.path : "",
        docCount: toNumber(row.doc_count),
        chunkCount: toNumber(row.chunk_count),
      })),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
