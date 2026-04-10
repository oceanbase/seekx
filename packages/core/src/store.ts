/**
 * store.ts — SQLite schema, migrations, and CRUD for seekx.
 *
 * Seven tables:
 *   collections  — indexed directory registrations
 *   documents    — one row per indexed file (mtime + hash for change detection)
 *   chunks       — chunked text segments within a document
 *   fts          — FTS5 virtual table; rowid == chunk_id for O(1) delete
 *   vec_chunks   — sqlite-vec virtual table; created lazily on first embed
 *   meta         — key/value store for schema version, embed model, dim, etc.
 *   llm_cache    — TTL-based cache for LLM responses (expand, rerank, hyde)
 *
 * FTS5 invariant: INSERT uses rowid = chunk_id so DELETE by rowid is O(1).
 * FTS5 does NOT cascade from chunks; callers must delete FTS rows before chunks.
 *
 * vec_chunks invariant: embeddings are L2-normalized before insertion so that
 * L2 distance is equivalent to cosine distance for unit vectors.
 * vec_chunks does NOT cascade from chunks (sqlite-vec virtual table has no FK
 * support); callers must delete vec_chunks rows in the same step as FTS rows.
 *
 * llm_cache invariant: cache_key is opaque (model + inputs hash); entries are
 * valid until (created_at + ttl_sec). Callers must call evictExpiredLLMCache()
 * periodically to reclaim space; seekx does this on store open.
 */

import type { Database } from "./db.ts";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface CollectionRow {
  name: string;
  path: string;
  pattern: string;
  ignore_json: string | null;
  created_at: number;
}

export interface DocumentRow {
  id: number;
  collection: string;
  path: string;
  title: string | null;
  mtime: number;
  hash: string;
  chunk_count: number;
  indexed_at: number;
}

export interface ChunkRow {
  id: number;
  doc_id: number;
  chunk_idx: number;
  content: string;
  heading_path: string | null;
  start_line: number;
  end_line: number;
  token_count: number;
}

export interface RawResult {
  chunk_id: number;
  doc_id: number;
  score: number; // higher = more relevant
  content: string;
  path: string;
  title: string | null;
  collection: string;
  start_line: number;
  end_line: number;
}

export interface IndexStatus {
  totalDocuments: number;
  totalChunks: number;
  embeddedChunks: number;
  /** True when the sqlite-vec native extension loaded successfully. */
  sqliteVecLoaded: boolean;
  /** True when extension is loaded and vec_chunks has been created (embed_dim known). */
  vectorSearchAvailable: boolean;
  embedModel: string | null;
  embedDim: number | null;
  collections: Array<{
    name: string;
    path: string;
    docCount: number;
    chunkCount: number;
    lastIndexed: number | null;
  }>;
}

export interface CollectionStats {
  docCount: number;
  chunkCount: number;
}

export interface AddCollectionInput {
  name: string;
  path: string;
  description?: string | null; // stored as comment; no schema column
  pattern?: string;
  ignore?: string[];
}

export interface DocInput {
  collection: string;
  path: string;
  title: string | null;
  mtime: number;
  hash: string;
}

export interface ChunkInput {
  doc_id: number;
  chunk_idx: number;
  content: string;
  heading_path: string | null;
  start_line: number;
  end_line: number;
  token_count: number;
}

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS collections (
  name         TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  pattern      TEXT NOT NULL DEFAULT '**/*.{md,txt,markdown}',
  ignore_json  TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  collection   TEXT    NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
  path         TEXT    NOT NULL,
  title        TEXT,
  mtime        INTEGER NOT NULL DEFAULT 0,
  hash         TEXT    NOT NULL DEFAULT '',
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL,
  UNIQUE (collection, path)
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_idx    INTEGER NOT NULL,
  content      TEXT    NOT NULL,
  heading_path TEXT,
  start_line   INTEGER NOT NULL DEFAULT 0,
  end_line     INTEGER NOT NULL DEFAULT 0,
  token_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (doc_id, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);

-- FTS5: rowid is set to chunk_id on INSERT so DELETE by rowid is O(1).
-- content stores jieba-expanded text (original + space-separated tokens).
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  content,
  tokenize = 'unicode61 remove_diacritics 1'
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Schema v2: LLM response cache (expand, rerank, hyde).
const SCHEMA_V2_ADD_LLM_CACHE = `
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key  TEXT    PRIMARY KEY,
  response   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  ttl_sec    INTEGER NOT NULL DEFAULT 3600
);
`;

type Migration = (db: Database) => void;

const MIGRATIONS: Record<number, Migration> = {
  1: (db) => {
    db.exec(SCHEMA_V1);
  },
  2: (db) => {
    db.exec(SCHEMA_V2_ADD_LLM_CACHE);
  },
};

const CURRENT_SCHEMA_VERSION = 2;

function runMigrations(db: Database): void {
  // meta table may not exist yet on first run; create it first.
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  const current = row ? Number.parseInt(row.value, 10) : 0;

  for (let v = current + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (migration) {
      migration(db);
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(
        String(v),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Store class
// ---------------------------------------------------------------------------

export class Store {
  private readonly db: Database;
  private vecLoaded = false;
  private vecDim: number | null = null;

  constructor(db: Database, vecLoaded: boolean) {
    this.db = db;
    this.vecLoaded = vecLoaded;
    runMigrations(db);

    // Enable WAL mode and foreign keys for better concurrency + integrity.
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

    // Read previously stored embed dim if any.
    const dim = this.getMeta("embed_dim");
    if (dim) this.vecDim = Number.parseInt(dim, 10);

    // Evict stale LLM cache entries on open to avoid unbounded growth.
    this.evictExpiredLLMCache();
  }

  // -------------------------------------------------------------------------
  // vec_chunks lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create vec_chunks with the given embedding dimension, or validate that the
   * existing table matches. Returns false if sqlite-vec is not loaded.
   */
  ensureVecTable(dim: number): boolean {
    if (!this.vecLoaded) return false;

    const storedDim = this.getMeta("embed_dim");
    if (storedDim && Number.parseInt(storedDim, 10) !== dim) {
      throw new Error(
        `Embed dimension mismatch: stored=${storedDim}, new=${dim}. Run 'seekx reindex <collection>' after changing the embed model.`,
      );
    }

    if (!storedDim) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding FLOAT[${dim}]
        );
      `);
      this.setMeta("embed_dim", String(dim));
      this.vecDim = dim;
    }
    return true;
  }

  /** Drop and recreate vec_chunks with a new dimension (for seekx reindex). */
  recreateVecTable(dim: number): boolean {
    if (!this.vecLoaded) return false;
    this.db.exec("DROP TABLE IF EXISTS vec_chunks;");
    this.db.exec(`
      CREATE VIRTUAL TABLE vec_chunks USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${dim}]
      );
    `);
    this.setMeta("embed_dim", String(dim));
    this.vecDim = dim;
    return true;
  }

  // -------------------------------------------------------------------------
  // Collections
  // -------------------------------------------------------------------------

  addCollection(input: AddCollectionInput): void {
    const pattern = input.pattern ?? "**/*.{md,txt,markdown}";
    const ignoreJson = input.ignore ? JSON.stringify(input.ignore) : null;
    this.db
      .prepare(
        `INSERT INTO collections(name, path, pattern, ignore_json, created_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET path=excluded.path, pattern=excluded.pattern,
           ignore_json=excluded.ignore_json`,
      )
      .run(input.name, input.path, pattern, ignoreJson, Math.floor(Date.now() / 1000));
  }

  listCollections(): CollectionRow[] {
    return this.db
      .prepare("SELECT name, path, pattern, ignore_json, created_at FROM collections ORDER BY name")
      .all() as CollectionRow[];
  }

  getCollection(name: string): CollectionRow | null {
    return (
      (this.db
        .prepare(
          "SELECT name, path, pattern, ignore_json, created_at FROM collections WHERE name = ?",
        )
        .get(name) as CollectionRow | null) ?? null
    );
  }

  removeCollection(name: string): boolean {
    // Deletes cascade to documents → chunks. FTS rows must be removed first.
    // We do a manual FTS cleanup before deleting documents.
    const docIds = this.db.prepare("SELECT id FROM documents WHERE collection = ?").all(name) as {
      id: number;
    }[];

    for (const { id } of docIds) {
      this._deleteChunkDerivedData(id);
    }

    const result = this.db.prepare("DELETE FROM collections WHERE name = ?").run(name);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  findDocumentByPath(collection: string, path: string): DocumentRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM documents WHERE collection = ? AND path = ?")
        .get(collection, path) as DocumentRow | null) ?? null
    );
  }

  upsertDocument(doc: DocInput): number {
    const now = Math.floor(Date.now() / 1000);
    // Use RETURNING to get the id regardless of insert vs update path.
    // sqlite3_last_insert_rowid() is unreliable in ON CONFLICT DO UPDATE.
    const row = this.db
      .prepare(
        `INSERT INTO documents(collection, path, title, mtime, hash, chunk_count, indexed_at)
         VALUES(?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(collection, path) DO UPDATE SET
           title=excluded.title, mtime=excluded.mtime, hash=excluded.hash,
           chunk_count=0, indexed_at=excluded.indexed_at
         RETURNING id`,
      )
      .get(doc.collection, doc.path, doc.title, doc.mtime, doc.hash, now) as { id: number };
    return row.id;
  }

  updateDocumentMtime(docId: number, mtime: number): void {
    this.db.prepare("UPDATE documents SET mtime = ? WHERE id = ?").run(mtime, docId);
  }

  /**
   * Delete a document and all its derived data. MUST delete FTS rows first
   * (FTS5 does not support cascade), then chunks (which cascade vec_chunks).
   */
  deleteDocument(docId: number): void {
    this._deleteChunkDerivedData(docId);
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
  }

  private _deleteChunkDerivedData(docId: number): void {
    // Fetch chunk ids before the cascade deletes them from chunks.
    const chunkIds = this.db.prepare("SELECT id FROM chunks WHERE doc_id = ?").all(docId) as {
      id: number;
    }[];
    const ftsStmt = this.db.prepare("DELETE FROM fts WHERE rowid = ?");
    // vec_chunks is a sqlite-vec virtual table with no FK to chunks, so it
    // does NOT cascade automatically — we must delete explicitly.
    const vecStmt =
      this.vecLoaded && this.vecDim
        ? this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?")
        : null;
    for (const { id } of chunkIds) {
      ftsStmt.run(id);
      vecStmt?.run(id);
    }
  }

  // -------------------------------------------------------------------------
  // Chunks
  // -------------------------------------------------------------------------

  insertChunk(chunk: ChunkInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO chunks(doc_id, chunk_idx, content, heading_path, start_line, end_line, token_count)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.doc_id,
        chunk.chunk_idx,
        chunk.content,
        chunk.heading_path,
        chunk.start_line,
        chunk.end_line,
        chunk.token_count,
      );

    const chunkId = Number(result.lastInsertRowid);
    // Keep chunk_count in sync on the parent document.
    this.db
      .prepare("UPDATE documents SET chunk_count = chunk_count + 1 WHERE id = ?")
      .run(chunk.doc_id);
    return chunkId;
  }

  getChunks(docId: number): ChunkRow[] {
    return this.db
      .prepare("SELECT * FROM chunks WHERE doc_id = ? ORDER BY chunk_idx")
      .all(docId) as ChunkRow[];
  }

  getChunkById(chunkId: number): ChunkRow | null {
    return (
      (this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(chunkId) as ChunkRow | null) ?? null
    );
  }

  // -------------------------------------------------------------------------
  // FTS (BM25)
  // FTS5 rowid == chunk_id — DELETE by rowid is O(1)
  // -------------------------------------------------------------------------

  insertFTS(chunkId: number, expandedContent: string): void {
    // rowid is explicitly set to chunk_id for fast deletion.
    this.db.prepare("INSERT INTO fts(rowid, content) VALUES(?, ?)").run(chunkId, expandedContent);
  }

  deleteFTS(chunkId: number): void {
    this.db.prepare("DELETE FROM fts WHERE rowid = ?").run(chunkId);
  }

  searchFTS(query: string, limit: number, collections?: string[]): RawResult[] {
    // Join fts → chunks → documents to get full result context.
    const collFilter =
      collections && collections.length > 0
        ? `AND d.collection IN (${collections.map(() => "?").join(",")})`
        : "";

    const sql = `
      SELECT
        c.id        AS chunk_id,
        c.doc_id    AS doc_id,
        -fts.rank   AS score,
        c.content   AS content,
        d.path      AS path,
        d.title     AS title,
        d.collection AS collection,
        c.start_line AS start_line,
        c.end_line   AS end_line
      FROM fts
      JOIN chunks c ON c.id = fts.rowid
      JOIN documents d ON d.id = c.doc_id
      WHERE fts MATCH ?
      ${collFilter}
      ORDER BY fts.rank
      LIMIT ?
    `;

    const params: (string | number)[] = [query];
    if (collections && collections.length > 0) params.push(...collections);
    params.push(limit);

    return this.db.prepare(sql).all(...params) as RawResult[];
  }

  // -------------------------------------------------------------------------
  // Vector search (sqlite-vec)
  // Embeddings must be L2-normalized before calling insertEmbedding.
  // -------------------------------------------------------------------------

  insertEmbedding(chunkId: number, normalizedVec: number[]): void {
    if (!this.vecLoaded || !this.vecDim) return;
    this.db
      .prepare("INSERT INTO vec_chunks(chunk_id, embedding) VALUES(?, ?)")
      .run(chunkId, JSON.stringify(normalizedVec));
  }

  searchVector(normalizedQuery: number[], limit: number, collections?: string[]): RawResult[] {
    if (!this.vecLoaded || !this.vecDim) return [];

    // sqlite-vec MATCH does not support JOINs in the same WHERE clause, so we
    // run KNN as a standalone query and join in application code.
    //
    // Adaptive fetch: when a collection filter is active, the initial fetch
    // may yield fewer than `limit` results after filtering. We double the
    // fetch size and retry (up to maxFetch) until we have enough results or
    // the index is exhausted.
    const hasCollFilter = Boolean(collections && collections.length > 0);
    const chunkStmt = this.db.prepare(
      `SELECT c.id AS chunk_id, c.doc_id, c.content, c.start_line, c.end_line,
              d.path, d.title, d.collection
       FROM chunks c JOIN documents d ON d.id = c.doc_id
       WHERE c.id = ?`,
    );

    let knnFetch = Math.max(limit * 3, 30);
    // Safety cap to avoid runaway fetches on large indexes.
    const maxFetch = Math.max(limit * 20, 200);

    for (;;) {
      type KnnRow = { chunk_id: number; distance: number };
      let knnRows: KnnRow[];
      try {
        knnRows = this.db
          .prepare(
            `SELECT chunk_id, distance FROM vec_chunks
             WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
          )
          .all(JSON.stringify(normalizedQuery), knnFetch) as KnnRow[];
      } catch {
        return [];
      }

      if (knnRows.length === 0) return [];

      // Step 2: Resolve chunk_id → chunk + document, applying collection filter.
      // cosine_sim = 1 - L2_distance² / 2  (exact for unit vectors)
      const results: RawResult[] = [];
      for (const knn of knnRows) {
        const row = chunkStmt.get(knn.chunk_id) as Omit<RawResult, "score"> | null;
        if (!row) continue;
        if (hasCollFilter && !collections!.includes(row.collection)) continue;
        const cosineSim = Math.max(0, 1 - (knn.distance * knn.distance) / 2);
        results.push({ ...row, score: cosineSim });
        if (results.length >= limit) return results;
      }

      // Return what we have if: no collection filter (no reason to retry),
      // the KNN index is exhausted, or we've hit the safety cap.
      if (!hasCollFilter || knnRows.length < knnFetch || knnFetch >= maxFetch) {
        return results;
      }
      knnFetch = Math.min(knnFetch * 2, maxFetch);
    }
  }

  // -------------------------------------------------------------------------
  // LLM response cache
  // -------------------------------------------------------------------------

  /**
   * Retrieve a cached LLM response. Returns null if the key is absent or the
   * entry has expired (created_at + ttl_sec ≤ now).
   */
  getCachedLLM(key: string): string | null {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT response FROM llm_cache
         WHERE cache_key = ? AND (created_at + ttl_sec) > ?`,
      )
      .get(key, now) as { response: string } | null;
    return row?.response ?? null;
  }

  /** Store a LLM response. Overwrites any existing entry for the same key. */
  setCachedLLM(key: string, response: string, ttlSec = 3600): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO llm_cache(cache_key, response, created_at, ttl_sec)
         VALUES(?, ?, ?, ?)`,
      )
      .run(key, response, now, ttlSec);
  }

  /**
   * Delete expired cache entries. Returns the number of rows deleted.
   * Should be called periodically (e.g. on store open) to reclaim space.
   */
  evictExpiredLLMCache(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(`DELETE FROM llm_cache WHERE (created_at + ttl_sec) <= ?`)
      .run(now);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // FTS5 snippet
  // -------------------------------------------------------------------------

  /**
   * Return an FTS5 snippet for a specific chunk, using the built-in
   * `snippet()` function which finds the densest multi-term match window.
   * Match terms are wrapped in `**` markers.
   *
   * Returns null when:
   *   - ftsQuery is empty
   *   - the chunk is not in the FTS index (e.g. a pure vector-only result)
   *   - the chunk does not match the query at all
   *
   * Callers should fall back to extractSnippet() when null is returned.
   *
   * @param chunkId  The chunk's rowid (== chunk.id, which is the FTS rowid).
   * @param ftsQuery A pre-built FTS5 MATCH expression (from buildFTSQuery).
   */
  getSnippetFTS(chunkId: number, ftsQuery: string): string | null {
    if (!ftsQuery) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT snippet(fts, 0, '**', '**', '…', 20) AS snip
           FROM fts WHERE rowid = ? AND fts MATCH ?`,
        )
        .get(chunkId, ftsQuery) as { snip: string } | null;
      return row?.snip ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Meta KV
  // -------------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(key, value);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  getStatus(): IndexStatus {
    const totalDocuments = (
      this.db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number }
    ).n;
    const totalChunks = (this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number })
      .n;

    let embeddedChunks = 0;
    if (this.vecLoaded && this.vecDim) {
      try {
        embeddedChunks = (
          this.db.prepare("SELECT COUNT(*) as n FROM vec_chunks").get() as { n: number }
        ).n;
      } catch {
        // vec_chunks may not exist yet
      }
    }

    const colRows = this.db
      .prepare(
        `SELECT c.name, c.path,
                COUNT(DISTINCT d.id) as doc_count,
                COUNT(ch.id) as chunk_count,
                MAX(d.indexed_at) as last_indexed
         FROM collections c
         LEFT JOIN documents d ON d.collection = c.name
         LEFT JOIN chunks ch ON ch.doc_id = d.id
         GROUP BY c.name
         ORDER BY c.name`,
      )
      .all() as Array<{
      name: string;
      path: string;
      doc_count: number;
      chunk_count: number;
      last_indexed: number | null;
    }>;

    return {
      totalDocuments,
      totalChunks,
      embeddedChunks,
      sqliteVecLoaded: this.vecLoaded,
      vectorSearchAvailable: this.vecLoaded && this.vecDim !== null,
      embedModel: this.getMeta("embed_model"),
      embedDim: this.vecDim,
      collections: colRows.map((r) => ({
        name: r.name,
        path: r.path,
        docCount: r.doc_count,
        chunkCount: r.chunk_count,
        lastIndexed: r.last_indexed,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Document retrieval (for seekx get)
  // -------------------------------------------------------------------------

  getDocumentById(docId: number): (DocumentRow & { chunks: ChunkRow[] }) | null {
    const doc = this.db
      .prepare("SELECT * FROM documents WHERE id = ?")
      .get(docId) as DocumentRow | null;
    if (!doc) return null;
    return { ...doc, chunks: this.getChunks(doc.id) };
  }

  /** Decode a short hex docid (e.g. "a3f2b1") to an integer document id. */
  decodeDocid(shortId: string): number | null {
    const n = Number.parseInt(shortId, 16);
    return Number.isNaN(n) ? null : n;
  }

  /** Encode an integer document id to a 6-char hex string. */
  encodeDocid(docId: number): string {
    return docId.toString(16).padStart(6, "0");
  }

  /** Return document count and chunk count for a collection. */
  collectionStats(name: string): CollectionStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT d.id) AS doc_count, COUNT(c.id) AS chunk_count
         FROM documents d
         LEFT JOIN chunks c ON c.doc_id = d.id
         WHERE d.collection = ?`,
      )
      .get(name) as { doc_count: number; chunk_count: number } | null;
    return { docCount: row?.doc_count ?? 0, chunkCount: row?.chunk_count ?? 0 };
  }

  /** Return all chunks for a document (ordered by chunk_idx). */
  getChunksByDocId(docId: number): ChunkRow[] {
    return this.getChunks(docId);
  }

  /**
   * Delete all documents (and their FTS/chunks/vec data) for a collection.
   * Used by seekx reindex before a full re-scan.
   */
  deleteAllDocuments(collection: string): void {
    const docs = this.db
      .prepare("SELECT id FROM documents WHERE collection = ?")
      .all(collection) as { id: number }[];
    for (const doc of docs) {
      this.deleteDocument(doc.id);
    }
  }

  /** Delete a document by collection + path (used by watcher on unlink). */
  deleteDocumentByPath(collection: string, path: string): void {
    const doc = this.findDocumentByPath(collection, path);
    if (doc) this.deleteDocument(doc.id);
  }

  /** Drop and recreate the vec_chunks virtual table (e.g. after model change). */
  resetVecTable(): void {
    this.db.exec("DROP TABLE IF EXISTS vec_chunks;");
    this.vecDim = null;
    // Table will be recreated on next ensureVecTable() call.
  }

  close(): void {
    this.db.close();
  }
}
