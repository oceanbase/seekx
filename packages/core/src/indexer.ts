/**
 * indexer.ts — File indexing pipeline shared by seekx add and watcher.ts.
 *
 * indexFile()      — indexes one file with mtime→hash two-level diff.
 * indexDirectory() — scans a glob pattern and calls indexFile() for each match.
 *
 * Change detection (two levels):
 *   1. Compare stat().mtimeMs to stored value. Equal → skip (0 file I/O).
 *   2. Read file, compute SHA-1. Equal hash → update mtime only.
 *   3. Hash changed → delete old data, re-chunk, re-index FTS, re-embed.
 *
 * Embedding:
 *   - Batched in groups of EMBED_BATCH_SIZE (32) to stay within API limits.
 *   - If embed fails, FTS rows are still written → BM25 remains functional.
 *   - Vec table is created lazily on first successful embed call.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { SeekxClient } from "./client.ts";
import { chunkDocument } from "./chunker.ts";
import type { Store } from "./store.ts";
import { expandForFTS } from "./tokenizer.ts";

const EMBED_BATCH_SIZE = 32;

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export type ProgressCallback = (indexed: number, total: number, filePath: string) => void;

export type IndexFileStatus = "indexed" | "skipped" | "mtime_only" | "error";

export interface IndexFileResult {
  status: IndexFileStatus;
  path: string;
  chunkCount?: number;
  embeddedCount?: number;
  error?: string;
}

export interface IndexDirectoryResult {
  indexed: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  totalFiles: number;
}

// ---------------------------------------------------------------------------
// Single file
// ---------------------------------------------------------------------------

/**
 * Index a single file. Handles two-level change detection and batch embedding.
 */
export async function indexFile(
  store: Store,
  client: SeekxClient | null,
  collection: string,
  filePath: string,
): Promise<IndexFileResult> {
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { status: "skipped", path: filePath };
  }

  // Level 1: mtime check (no file read).
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch (e) {
    return { status: "error", path: filePath, error: String(e) };
  }

  const existing = store.findDocumentByPath(collection, filePath);
  if (existing && existing.mtime === mtimeMs) {
    return { status: "skipped", path: filePath };
  }

  // Level 2: read content + hash check.
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (e) {
    return { status: "error", path: filePath, error: String(e) };
  }

  const hash = sha1(content);

  if (existing && existing.hash === hash) {
    // Only mtime drifted (e.g. `touch`). Update mtime, skip re-embedding.
    store.updateDocumentMtime(existing.id, mtimeMs);
    return { status: "mtime_only", path: filePath };
  }

  // --- Content changed or new file ---
  if (existing) {
    // deleteDocument cleans FTS first, then cascades chunks → vec_chunks.
    store.deleteDocument(existing.id);
  }

  const isMarkdown = ext === ".md" || ext === ".markdown";
  const title = extractTitle(content, filePath);

  const docId = store.upsertDocument({ collection, path: filePath, title, mtime: mtimeMs, hash });
  const chunks = chunkDocument(content, isMarkdown);

  // Write chunks + FTS.
  const chunkIds: number[] = [];
  for (const chunk of chunks) {
    const chunkId = store.insertChunk({
      doc_id: docId,
      chunk_idx: chunk.chunk_idx,
      content: chunk.content,
      heading_path: chunk.heading_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      token_count: chunk.token_count,
    });
    chunkIds.push(chunkId);
    store.insertFTS(chunkId, expandForFTS(chunk.content));
  }

  // Batch embedding (fail-open: FTS already written above).
  let embeddedCount = 0;
  if (client && chunks.length > 0) {
    embeddedCount = await embedChunks(store, client, chunks, chunkIds);
  }

  return { status: "indexed", path: filePath, chunkCount: chunks.length, embeddedCount };
}

async function embedChunks(
  store: Store,
  client: SeekxClient,
  chunks: ReturnType<typeof chunkDocument>,
  chunkIds: number[],
): Promise<number> {
  const texts = chunks.map((c) => c.embeddingContent);
  let embeddedCount = 0;

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await client.embed(batch);
    if (!vecs) break; // fail-open: stop but keep what was already embedded

    for (let j = 0; j < vecs.length; j++) {
      const vec = vecs[j];
      const chunkId = chunkIds[i + j];
      if (vec && chunkId != null) {
        // Ensure vec_chunks table exists with correct dimension.
        if (store.ensureVecTable(vec.length)) {
          store.insertEmbedding(chunkId, vec); // client already L2-normalizes
          embeddedCount++;
        }
      }
    }
  }

  return embeddedCount;
}

// ---------------------------------------------------------------------------
// Directory scan
// ---------------------------------------------------------------------------

/**
 * Scan a directory with a glob pattern and index all matching files.
 *
 * @param store      Open store instance.
 * @param client     API client (null if embed not configured).
 * @param collection Collection name (must already exist in store).
 * @param rootPath   Absolute path to the collection root.
 * @param pattern    Glob pattern relative to rootPath.
 * @param ignore     Path patterns to skip.
 * @param onProgress Optional per-file progress callback.
 */
export async function indexDirectory(
  store: Store,
  client: SeekxClient | null,
  collection: string,
  rootPath: string,
  pattern: string,
  ignore: string[],
  onProgress?: ProgressCallback,
): Promise<IndexDirectoryResult> {
  const absRoot = resolve(rootPath);
  const files: string[] = [];

  // Use Bun's built-in Glob which is available in all Bun versions.
  const { Glob } = await import("bun");
  const globber = new Glob(pattern);
  for await (const entry of globber.scan({ cwd: absRoot, absolute: false, followSymlinks: true })) {
    const absPath = resolve(absRoot, entry);
    if (!isIgnored(absPath, absRoot, ignore)) {
      files.push(absPath);
    }
  }

  let indexed = 0;
  let skipped = 0;
  const errors: Array<{ path: string; error: string }> = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!;
    onProgress?.(i + 1, files.length, filePath);

    const result = await indexFile(store, client, collection, filePath);

    if (result.status === "indexed" || result.status === "mtime_only") {
      indexed++;
    } else if (result.status === "skipped") {
      skipped++;
    } else {
      errors.push({ path: filePath, error: result.error ?? "unknown error" });
    }
  }

  return { indexed, skipped, errors, totalFiles: files.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1(content: string): string {
  return createHash("sha1").update(content, "utf-8").digest("hex");
}

function extractTitle(content: string, filePath: string): string | null {
  const m = /^#{1,4}\s+(.+)$/m.exec(content);
  if (m) return m[1]!.trim();
  const stem = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? null;
  return stem ?? null;
}

function isIgnored(absPath: string, absRoot: string, patterns: string[]): boolean {
  const rel = absPath.slice(absRoot.length + 1);
  for (const pat of patterns) {
    if (pat.startsWith("*.")) {
      if (rel.endsWith(pat.slice(1))) return true;
    } else if (rel === pat || rel.startsWith(`${pat}/`) || rel.includes(`/${pat}/`)) {
      return true;
    }
  }
  return false;
}
