/**
 * search.ts — Hybrid search pipeline: expand → BM25 + Vector → RRF → rerank.
 *
 * Pipeline:
 *   1. [expand]  Query expansion via LLM (fail-open: use original query).
 *   2. [BM25]    FTS5 search for each expanded query.
 *   3. [vector]  sqlite-vec kNN for each expanded query (skip if unavailable).
 *   4. [RRF]     Reciprocal Rank Fusion merges all result lists.
 *   5. [rerank]  Cross-encoder reranking of top candidates (fail-open: skip).
 *
 * RRF formula: score(d) = Σ 1 / (k + rank_i(d)),  k = 60 (standard value).
 *
 * Degradation (all silent, exit code 2 for the CLI):
 *   expand unavailable  → use original query only
 *   embed unavailable   → skip vector branch, BM25 only
 *   sqlite-vec absent   → skip vector branch
 *   rerank unavailable  → return RRF top-K directly
 */

import type { RerankResult, SeekxClient } from "./client.ts";
import type { RawResult, Store } from "./store.ts";
import { buildFTSQuery } from "./tokenizer.ts";

const RRF_K = 60;

export interface SearchOptions {
  collections?: string[];
  limit?: number;
  mode?: "hybrid" | "bm25" | "vector";
  useRerank?: boolean;
  useExpand?: boolean;
  onProgress?: SearchProgressCallback;
}

export type SearchProgressEvent =
  | {
      phase: "start";
      mode: "hybrid" | "bm25" | "vector";
      useExpand: boolean;
      useRerank: boolean;
    }
  | { phase: "expand_start"; query: string }
  | { phase: "expand_done"; expandedQueries: string[] }
  | { phase: "bm25_start"; totalQueries: number }
  | { phase: "bm25_progress"; completed: number; totalQueries: number; query: string }
  | { phase: "vector_start"; totalQueries: number }
  | { phase: "vector_progress"; completed: number; totalQueries: number; query: string }
  | { phase: "rerank_start"; candidateCount: number }
  | { phase: "rerank_done"; candidateCount: number; applied: boolean }
  | { phase: "done"; resultCount: number; warningCount: number };

export type SearchProgressCallback = (event: SearchProgressEvent) => void;

export interface SearchResult {
  docid: string; // short hex id (encodeDocid)
  chunk_id: number;
  file: string;
  title: string | null;
  collection: string;
  score: number; // 0–1 (normalized RRF or rerank score)
  snippet: string;
  start_line: number;
  end_line: number;
  expandedQueries?: string[]; // only set if expand was used
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function hybridSearch(
  store: Store,
  client: SeekxClient | null,
  query: string,
  opts: SearchOptions = {},
): Promise<{ results: SearchResult[]; expandedQueries: string[]; warnings: string[] }> {
  const limit = opts.limit ?? 10;
  const mode = opts.mode ?? "hybrid";
  const useRerank = opts.useRerank ?? true;
  const useExpand = opts.useExpand ?? true;
  const collections = opts.collections;
  const onProgress = opts.onProgress;
  const warnings: string[] = [];

  onProgress?.({ phase: "start", mode, useExpand, useRerank });

  // --- Step 1: Query expansion ---
  let expandedQueries = [query];
  if (useExpand && client && mode !== "bm25") {
    onProgress?.({ phase: "expand_start", query });
    const expanded = await client.expand(query);
    if (expanded) {
      expandedQueries = expanded;
    }
    // No warning if expand unavailable — degradation is transparent.
    onProgress?.({ phase: "expand_done", expandedQueries });
  }

  // --- Step 2: BM25 + Vector for each expanded query ---
  const candidateLimit = Math.max(limit * 4, 40);
  const allRawResults: Array<{ results: RawResult[]; listId: string }> = [];

  if (mode === "hybrid" || mode === "bm25") {
    onProgress?.({ phase: "bm25_start", totalQueries: expandedQueries.length });
    for (const [i, q] of expandedQueries.entries()) {
      const ftsQuery = buildFTSQuery(q);
      onProgress?.({ phase: "bm25_progress", completed: i + 1, totalQueries: expandedQueries.length, query: q });
      if (!ftsQuery) continue;
      try {
        const results = store.searchFTS(ftsQuery, candidateLimit, collections);
        allRawResults.push({ results, listId: `bm25-${i}` });
      } catch (e) {
        warnings.push(`BM25 search failed: ${e}`);
      }
    }
  }

  if ((mode === "hybrid" || mode === "vector") && client) {
    onProgress?.({ phase: "vector_start", totalQueries: expandedQueries.length });
    for (const [i, q] of expandedQueries.entries()) {
      onProgress?.({
        phase: "vector_progress",
        completed: i + 1,
        totalQueries: expandedQueries.length,
        query: q,
      });
      const vecs = await client.embed([q]);
      if (!vecs || !vecs[0]) {
        if (mode === "vector") warnings.push("Vector search unavailable: embed API failed.");
        break;
      }
      const results = store.searchVector(vecs[0], candidateLimit, collections);
      if (results.length > 0) {
        allRawResults.push({ results, listId: `vec-${i}` });
      }
    }
  }

  if (allRawResults.length === 0) {
    onProgress?.({ phase: "done", resultCount: 0, warningCount: warnings.length });
    return { results: [], expandedQueries, warnings };
  }

  // --- Step 3: RRF fusion ---
  const fused = rrfFuse(allRawResults.map((r) => r.results));
  const topCandidates = fused.slice(0, candidateLimit);

  // --- Step 4: Rerank ---
  let finalRaw = topCandidates;
  if (useRerank && client && topCandidates.length > 1) {
    onProgress?.({ phase: "rerank_start", candidateCount: topCandidates.length });
    const reranked = await client.rerank(
      query,
      topCandidates.map((r) => r.content),
    );
    if (reranked) {
      finalRaw = applyRerank(topCandidates, reranked);
    }
    onProgress?.({
      phase: "rerank_done",
      candidateCount: topCandidates.length,
      applied: reranked !== null,
    });
  }

  // --- Step 5: Format results ---
  // Normalize scores so the top result = 1.0, others are relative.
  const sliced = finalRaw.slice(0, limit);
  const topScore = sliced[0]?.score ?? 1;
  const results: SearchResult[] = sliced.map((raw) => ({
    docid: store.encodeDocid(raw.doc_id),
    chunk_id: raw.chunk_id,
    file: raw.path,
    title: raw.title,
    collection: raw.collection,
    score: topScore > 0 ? Math.min(1, raw.score / topScore) : 0,
    snippet: extractSnippet(raw.content, query, 180),
    start_line: raw.start_line,
    end_line: raw.end_line,
  }));

  onProgress?.({ phase: "done", resultCount: results.length, warningCount: warnings.length });

  return {
    results,
    expandedQueries: expandedQueries.length > 1 ? expandedQueries : [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// RRF implementation
// ---------------------------------------------------------------------------

function rrfFuse(lists: RawResult[][]): RawResult[] {
  // Score map: chunk_id → { rrfScore, raw }
  const scoreMap = new Map<number, { score: number; raw: RawResult }>();

  for (const list of lists) {
    // Sort each list by score descending to assign ranks.
    const sorted = [...list].sort((a, b) => b.score - a.score);
    for (let rank = 0; rank < sorted.length; rank++) {
      const raw = sorted[rank];
      if (!raw) continue;
      const rrfContrib = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(raw.chunk_id);
      if (existing) {
        existing.score += rrfContrib;
      } else {
        scoreMap.set(raw.chunk_id, { score: rrfContrib, raw });
      }
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, raw }) => ({ ...raw, score }));
}

function applyRerank(candidates: RawResult[], reranked: RerankResult[]): RawResult[] {
  // Reranker returns indices into candidates + scores. Reorder accordingly.
  return reranked.flatMap(({ index, score }) => {
    const raw = candidates[index];
    return raw ? [{ ...raw, score }] : [];
  });
}

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

/**
 * Extract a short context snippet from chunk content, centred around the
 * first occurrence of any query term.
 */
function extractSnippet(content: string, query: string, maxLen: number): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const lower = content.toLowerCase();

  let best = 0;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1) {
      best = idx;
      break;
    }
  }

  const start = Math.max(0, best - Math.floor(maxLen / 3));
  const end = Math.min(content.length, start + maxLen);
  let snippet = content.slice(start, end).replace(/\n+/g, " ").trim();

  if (start > 0) snippet = `…${snippet}`;
  if (end < content.length) snippet = `${snippet}…`;

  return snippet;
}
