/**
 * formatter.ts — Output formatting for CLI commands.
 *
 * Supports three output modes:
 *   default  — human-readable text (colors, tables)
 *   --json   — JSON (one object per command)
 *   --files  — newline-separated file paths only (for scripting)
 *   --md     — Markdown (for piping to note-taking tools)
 *
 * Default format (one block per result):
 *
 *   <colored-file>:start_line
 *   Title: <title>          ← only when title is non-null
 *   Score: 39%
 *
 *   @@ -start,count @@
 *   <snippet>
 *
 * Each file gets a deterministic ANSI 256-color derived from its path so
 * multiple chunks from the same file are visually grouped at a glance.
 */

import type { SearchResult } from "@seekx/core";

// ---------------------------------------------------------------------------
// Per-file stable color
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic ANSI 256-color escape sequence from a file path.
 * Uses a small curated palette of distinct, readable colors so that each
 * unique path gets a consistent color across result sets.
 */
function fileAnsiColor(file: string): string {
  // djb2 hash over the path characters.
  let h = 5381;
  for (let i = 0; i < file.length; i++) {
    h = (((h << 5) + h) ^ file.charCodeAt(i)) >>> 0;
  }
  // Curated ANSI-256 palette: bright, distinct hues that work on dark and
  // light terminals.  Excludes very dark / very light entries.
  const PALETTE = [
    196, 202, 208, 214, 220, 118, 82, 46, 48, 51, 45, 39, 33, 27, 57, 93,
    129, 165, 201, 199, 160, 172, 148, 85, 123, 141,
  ];
  const code = PALETTE[h % PALETTE.length];
  return `\x1b[38;5;${code}m`;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export function formatSearchResults(
  results: SearchResult[],
  opts: {
    json?: boolean | undefined;
    files?: boolean | undefined;
    md?: boolean | undefined;
    expandedQueries?: string[] | undefined;
  },
): void {
  if (opts.json) {
    console.log(JSON.stringify({ results, expandedQueries: opts.expandedQueries ?? [] }, null, 2));
    return;
  }

  if (opts.files) {
    // Deduplicate by file path.
    const seen = new Set<string>();
    for (const r of results) {
      if (!seen.has(r.file)) {
        seen.add(r.file);
        console.log(r.file);
      }
    }
    return;
  }

  if (results.length === 0) {
    console.log("No results.");
    return;
  }

  if (opts.md) {
    for (const r of results) {
      const titleStr = r.title ? ` — ${r.title}` : "";
      console.log(`## [${r.file}${titleStr}](${r.file})\n`);
      console.log(
        `> Score: ${Math.round(r.score * 100)}% | Lines ${r.start_line}–${r.end_line}\n`,
      );
      console.log(r.snippet);
      console.log();
    }
    return;
  }

  // Default: human-readable.
  for (const r of results) {
    const color = fileAnsiColor(r.file);
    const lineCount = r.end_line - r.start_line + 1;

    // Header line: colored filename + start line number.
    console.log(`${color}${r.file}${RESET}:${r.start_line}`);

    // Title (optional).
    if (r.title) {
      console.log(`Title: ${r.title}`);
    }

    // Score as percentage.
    console.log(`Score: ${Math.round(r.score * 100)}%`);

    // Diff-style line range header.
    console.log(`\n${DIM}@@ -${r.start_line},${lineCount} @@${RESET}`);

    // Snippet.
    console.log(r.snippet);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Collection table
// ---------------------------------------------------------------------------

export interface CollectionRow {
  name: string;
  path: string;
  docCount: number;
  chunkCount: number;
}

export function formatCollections(
  rows: CollectionRow[],
  opts: { json?: boolean | undefined } = {},
): void {
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No collections. Use 'seekx add <path>' to add one.");
    return;
  }

  const nameW = Math.max(10, ...rows.map((r) => r.name.length));
  const header = `  ${"NAME".padEnd(nameW)}  ${"DOCS".padStart(6)}  ${"CHUNKS".padStart(7)}  PATH`;
  console.log(header);
  console.log(`  ${"-".repeat(header.length - 2)}`);

  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(nameW)}  ${String(r.docCount).padStart(6)}  ${String(r.chunkCount).padStart(7)}  ${r.path}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusData {
  dbPath: string;
  embedOk: boolean | null;
  // Fields from store.getStatus() (IndexStatus)
  totalDocuments: number;
  totalChunks: number;
  embeddedChunks: number;
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

export function formatStatus(data: StatusData, opts: { json?: boolean | undefined } = {}): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const ok = (b: boolean | null) =>
    b == null ? "\x1b[2m—\x1b[0m" : b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";

  console.log("\x1b[1mseekx status\x1b[0m");
  console.log(`  database     ${data.dbPath}`);
  console.log(`  sqlite-vec   ${ok(data.vectorSearchAvailable)}`);
  console.log(`  embed API    ${ok(data.embedOk)}`);

  if (data.embedModel) {
    const dimStr = data.embedDim ? `  dim=${data.embedDim}` : "";
    console.log(`  embed model  ${data.embedModel}${dimStr}`);
  }

  const embeddedPct =
    data.totalChunks > 0 ? `${Math.round((data.embeddedChunks / data.totalChunks) * 100)}%` : "—";
  console.log(`  documents    ${data.totalDocuments}`);
  console.log(
    `  chunks       ${data.totalChunks}  (embedded: ${data.embeddedChunks} / ${embeddedPct})`,
  );
  console.log();

  if (data.collections.length === 0) {
    console.log("  No collections. Use 'seekx add <path>' to add one.");
    return;
  }

  const nameW = Math.max(10, ...data.collections.map((c) => c.name.length));
  const header = `  ${"NAME".padEnd(nameW)}  ${"DOCS".padStart(6)}  ${"CHUNKS".padStart(7)}  PATH`;
  console.log(header);
  console.log(`  ${"-".repeat(header.length - 2)}`);

  for (const c of data.collections) {
    console.log(
      `  ${c.name.padEnd(nameW)}  ${String(c.docCount).padStart(6)}  ${String(c.chunkCount).padStart(7)}  ${c.path}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Document chunk
// ---------------------------------------------------------------------------

export function formatChunk(
  chunk: {
    file: string;
    title: string | null;
    content: string;
    start_line: number;
    end_line: number;
  },
  opts: { json?: boolean | undefined; md?: boolean | undefined } = {},
): void {
  if (opts.json) {
    console.log(JSON.stringify(chunk, null, 2));
    return;
  }
  if (opts.md) {
    const title = chunk.title ? `# ${chunk.title}\n\n` : "";
    console.log(`${title}${chunk.content}`);
    return;
  }
  const titleStr = chunk.title ? ` (${chunk.title})` : "";
  console.log(`\x1b[36m${chunk.file}\x1b[0m:${chunk.start_line}–${chunk.end_line}${titleStr}`);
  console.log();
  console.log(chunk.content);
}
