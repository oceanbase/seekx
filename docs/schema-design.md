# seekx Database Schema Design

> Version: v1 | Status: Draft | Updated: 2026-04-08

---

## Overview

seekx uses a single SQLite file (`~/.seekx/index.sqlite`) as its storage backend.
The schema covers four concerns:

1. **Document tracking** — file path, modification time, content hash for incremental diff
2. **Full-text search** — FTS5 virtual table with pre-tokenized Chinese content
3. **Vector search** — `sqlite-vec` virtual table for k-nearest-neighbor retrieval
4. **Configuration** — collection definitions and runtime metadata

The design principle is separation of concerns: `documents`, `chunks`, `fts`, and
`vec_chunks` are distinct tables that reference each other, rather than one monolithic
table. This keeps each concern queryable independently and makes future schema
migrations (e.g., adding multi-tenancy columns) low-risk.

---

## Tables

### `collections`

Stores the set of indexed directories. The canonical source of truth is
`~/.seekx/config.yml`; this table is a DB-side cache synced on startup and on
`seekx add` / `seekx watch`.

```sql
CREATE TABLE IF NOT EXISTS collections (
  name         TEXT PRIMARY KEY,
  path         TEXT NOT NULL,              -- absolute path to watch root
  pattern      TEXT NOT NULL               -- glob relative to path
                 DEFAULT '**/*.{md,txt,markdown}',
  ignore_json  TEXT,                       -- JSON array of glob patterns to skip
  created_at   INTEGER NOT NULL            -- Unix epoch seconds
);
```

**Notes:**
- `name` is user-supplied (e.g. `"mynotes"`). Validated to `[a-zA-Z0-9_-]+`.
- `ignore_json` stores the `watch.ignore` list from `config.yml` as a JSON array
  (e.g. `'["node_modules","*.tmp"]'`). Kept as TEXT to avoid a separate join table.
- The table has no `updated_at` because collection metadata rarely changes; updates
  drop and re-insert the row.

---

### `documents`

One row per indexed file. Tracks identity and change-detection state.

```sql
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  collection   TEXT    NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
  path         TEXT    NOT NULL,           -- absolute file path
  title        TEXT,                       -- extracted first heading or filename stem
  mtime        INTEGER NOT NULL DEFAULT 0, -- file mtime (ms), for fast change detection
  hash         TEXT    NOT NULL DEFAULT '', -- SHA-1 of file content, re-embed only when changed
  chunk_count  INTEGER NOT NULL DEFAULT 0, -- denormalized count of live chunks
  indexed_at   INTEGER NOT NULL,           -- Unix epoch seconds of last successful index run
  UNIQUE (collection, path)
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
CREATE INDEX IF NOT EXISTS idx_documents_hash       ON documents(hash);
```

**Change-detection logic (`watcher.ts`):**
1. On `chokidar` `change` event, stat the file → compare `mtime`.
2. If `mtime` matches the stored value, skip (no content change).
3. If `mtime` differs, re-read and SHA-1 the content → compare `hash`.
4. If `hash` matches (e.g. touch without edit), update `mtime` only, skip re-embedding.
5. If `hash` differs, re-chunk, re-insert FTS rows, re-embed, update `hash` + `mtime`.

Two-level check (mtime then hash) keeps the hot path (no change) at O(1) DB read
with zero file I/O.

---

### `chunks`

One row per text chunk within a document. Stores the raw content and its position
for snippet extraction and overlap-aware re-chunking.

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_idx    INTEGER NOT NULL,           -- 0-based index within the document
  content      TEXT    NOT NULL,           -- raw chunk text (used for rerank input)
  heading_path TEXT,                       -- e.g. "## Chapter 2 > ### 3.1 Section"
  start_line   INTEGER NOT NULL DEFAULT 0,
  end_line     INTEGER NOT NULL DEFAULT 0,
  token_count  INTEGER NOT NULL DEFAULT 0, -- estimated token count (chars / 4)
  UNIQUE (doc_id, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
```

**Chunking strategy (`chunker.ts`):**
- Target size: 900 tokens (≈ 3600 chars), hard cap at 1024 tokens.
- Overlap: 15% trailing context carried into the next chunk (≈ 135 tokens).
- Split boundary: Markdown heading (`#`–`####`) preferred over mid-paragraph split.
- `heading_path` is prepended to the chunk text before embedding to provide
  structural context (e.g., searching "rerank" returns the chunk tagged under
  "## Search Pipeline > ### Rerank").

---

### `fts`

FTS5 virtual table for BM25 full-text search. Stores pre-tokenized content to
support Chinese without a native C tokenizer extension.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  chunk_id  UNINDEXED,                     -- FK back to chunks.id
  content,                                 -- jieba-expanded text (see below)
  tokenize = 'unicode61 remove_diacritics 1'
);
```

**Chinese tokenization approach:**

FTS5's built-in tokenizers (`unicode61`, `ascii`) do not segment Chinese text.
Registering a custom C tokenizer would require a native extension and break the
zero-compile promise.

The workaround is **pre-tokenization at insert time**: before inserting into `fts`,
the content is transformed by `tokenizer.ts`:

```
original:  "数据库连接池的最佳实践"
expanded:  "数据库连接池的最佳实践 数据库 连接 池 的 最佳 实践"
```

The FTS5 row stores both the original text (for exact-match and phrase search) and
the jieba-segmented tokens (for single-character and sub-word recall). At search
time, the user query is similarly expanded:

```
query:     "数据库连接"
fts match: "数据库连接 OR 数据库 OR 连接"
```

This approach trades some FTS index size for compatibility and zero native
compilation. The tradeoff is acceptable for personal-scale corpora (< 100K chunks).

**On delete / update:** FTS5 does not support `DELETE WHERE`; rows are deleted via
the shadowtable `fts_content` or by using the `delete` command. seekx uses the
`fts` `delete` trigger pattern:

```sql
INSERT INTO fts(fts, rank) VALUES('delete', <chunk_id>);
```

Actually, seekx uses FTS5 external-content strategy: on `doc` delete, it deletes
from `chunks` (cascade from `documents`), then runs:

```sql
INSERT INTO fts(fts) VALUES('rebuild');  -- only on full reindex
-- or, for incremental:
DELETE FROM fts WHERE chunk_id = ?;      -- rowid-based delete
```

---

### `vec_chunks`

`sqlite-vec` virtual table for cosine-similarity k-nearest-neighbor search.

```sql
-- Created after sqlite-vec extension is loaded.
-- Embedding dimension is read from config at DB init time and stored in meta.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id   INTEGER PRIMARY KEY,          -- matches chunks.id
  embedding  FLOAT[1024]                   -- dimension set by embed model config
);
```

**Dimension management:**

The embedding dimension depends on the configured model (e.g., `Qwen3-Embedding-0.6B`
→ 1024, `BGE-M3` → 1024, `text-embedding-3-small` → 1536). The dimension is fixed
at DB creation time and stored in `meta`:

```sql
INSERT OR REPLACE INTO meta VALUES ('embed_dim', '1024');
INSERT OR REPLACE INTO meta VALUES ('embed_model', 'Qwen/Qwen3-Embedding-0.6B');
```

Changing the embed model requires a full reindex (`seekx reindex --collection <name>`),
which drops and recreates `vec_chunks` with the new dimension. seekx detects a
model mismatch on startup (stored `embed_model` ≠ config `embed_model`) and emits
a warning.

**Query pattern:**

```sql
SELECT chunk_id, distance
FROM   vec_chunks
WHERE  embedding MATCH ?          -- serialized float32 vector
ORDER  BY distance
LIMIT  ?;
```

`sqlite-vec` uses cosine distance by default for `FLOAT[]` columns; no `WITH` clause
needed unlike some other vector extensions.

---

### `meta`

Key-value store for runtime metadata and schema versioning.

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Reserved keys:**

| Key | Example Value | Purpose |
|-----|---------------|---------|
| `schema_version` | `"1"` | Triggers migration on version bump |
| `embed_dim` | `"1024"` | Validate against config on startup |
| `embed_model` | `"Qwen/Qwen3-Embedding-0.6B"` | Warn on model change |
| `created_at` | `"1712534400"` | DB creation timestamp |
| `seekx_version` | `"0.1.0"` | CLI version that last wrote the DB |

---

## Entity-Relationship Summary

```
collections
  │  name (PK)
  │
  └─< documents (collection FK)
        │  id (PK)
        │  path, mtime, hash, title
        │
        └─< chunks (doc_id FK)
              │  id (PK)
              │  chunk_idx, content, heading_path, start_line, end_line
              │
              ├── fts (chunk_id → chunks.id)
              │     FTS5 virtual table, BM25 search
              │
              └── vec_chunks (chunk_id PK → chunks.id)
                    vec0 virtual table, cosine kNN

meta (standalone KV)
```

All foreign keys use `ON DELETE CASCADE` so removing a collection or document
automatically cleans up chunks, FTS rows, and vector rows.

---

## Indexing Lifecycle

```
seekx add ~/notes --name mynotes
  │
  ├─ INSERT INTO collections
  │
  └─ for each matched file:
       ├─ INSERT INTO documents (path, mtime, hash, ...)
       ├─ chunk content  →  INSERT INTO chunks (×N)
       ├─ tokenize each chunk  →  INSERT INTO fts (chunk_id, content)
       └─ embed each chunk (batch)  →  INSERT INTO vec_chunks (chunk_id, embedding)

seekx watch
  │
  └─ chokidar 'change' event:
       ├─ stat file  →  compare mtime
       ├─ hash file  →  compare hash          (skip if unchanged)
       ├─ DELETE FROM chunks WHERE doc_id = ? (cascade fts + vec_chunks)
       └─ re-chunk, re-insert (same as add)
```

---

## Migration Strategy

Schema version is stored in `meta('schema_version')`. On every DB open, `store.ts`
reads this value and runs any pending migration functions:

```typescript
const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: migrateV1,   // initial schema
  2: migrateV2,   // future: add source_type column to documents
};
```

Migrations are append-only `ALTER TABLE ADD COLUMN` or new table creation; they
never drop columns. Destructive changes (e.g., changing FTS tokenizer) require a
`seekx reindex` user action documented in the changelog.

---

## Design Decisions & Alternatives

| Decision | Chosen | Rejected | Reason |
|----------|--------|----------|--------|
| Vector storage | `sqlite-vec` (`vec0`) | `pgvector`, pure-JS cosine | Pre-compiled 5 platforms, SIMD, single-file DB |
| Chinese FTS | Pre-tokenization (jieba expand) | Native C tokenizer extension | Zero native compilation; acceptable for personal scale |
| FTS content mode | Normal (content stored in FTS) | External content table | Simpler implementation; avoids sync complexity at MVP stage |
| Chunk overlap | 15% trailing (~135 tokens) | No overlap / 50% overlap | Standard RAG practice; reduces boundary miss rate |
| Hash algorithm | SHA-1 (hex 40 chars) | SHA-256, MD5 | Collision risk negligible for file change detection; SHA-1 is faster |
| Embed dim storage | `meta` table | Hardcoded constant | Allows model switching without code change |
| Collection config | Dual: YAML (truth) + SQLite (cache) | SQLite only | YAML is human-editable and git-trackable; SQLite is query-efficient |
