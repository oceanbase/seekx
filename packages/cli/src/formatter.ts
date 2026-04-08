/**
 * formatter.ts — Output formatting for CLI commands.
 *
 * Supports three output modes:
 *   default  — human-readable text (colors, tables)
 *   --json   — JSON (one object per command)
 *   --files  — newline-separated file paths only (for scripting)
 *   --md     — Markdown (for piping to note-taking tools)
 */

import type { SearchResult } from "@seekx/core";

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
      console.log(`> Score: ${r.score.toFixed(3)} | Lines ${r.start_line}–${r.end_line}\n`);
      console.log(r.snippet);
      console.log();
    }
    return;
  }

  // Default: human-readable.
  for (const r of results) {
    const scoreStr = `\x1b[33m${r.score.toFixed(3)}\x1b[0m`;
    const titleStr = r.title ? ` \x1b[2m(${r.title})\x1b[0m` : "";
    console.log(`\x1b[36m${r.file}\x1b[0m:${r.start_line}${titleStr} [${scoreStr}]`);
    console.log(`  ${r.snippet}`);
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
