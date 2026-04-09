/**
 * search.ts — Hybrid search pipeline: expand → BM25 + Vector + HyDE → RRF → rerank.
 *
 * Pipeline:
 *   1. [expand]  Query expansion via LLM (fail-open: use original query).
 *   2. [BM25]    FTS5 search for each expanded query.
 *   3. [vector]  sqlite-vec kNN for each expanded query (skip if unavailable).
 *   4. [hyde]    Hypothetical Document Embedding: embed a synthesized answer
 *                and add a vector search pass (opt-in via useHyde).
 *   5. [RRF]     Reciprocal Rank Fusion merges all result lists.
 *   6. [rerank]  Cross-encoder reranking of top candidates (fail-open: skip).
 *
 * RRF formula: score(d) = Σ weight_i / (k + rank_i(d)),  k = 60 (standard value).
 * Original query lists use weight=2; expanded-query lists use weight=1.
 *
 * Top-rank bonus: +0.05 for any document ranked #1 in any list, +0.02 for #2-3.
 * These bonuses preserve strong per-source signals that RRF alone would dilute.
 *
 * Position-aware rerank blend:
 *   Reranker replaces scores by position in the RRF-sorted candidate list:
 *     RRF rank 0–2  → 75% RRF + 25% reranker (protect high-confidence retrievals)
 *     RRF rank 3–9  → 60% RRF + 40% reranker
 *     RRF rank 10+  → 40% RRF + 60% reranker (trust reranker more for lower ranks)
 *
 * Degradation (all silent, exit code 2 for the CLI):
 *   expand unavailable  → use original query only
 *   embed unavailable   → skip vector branch, BM25 only
 *   sqlite-vec absent   → skip vector branch
 *   hyde unavailable    → skip hyde branch
 *   rerank unavailable  → return RRF top-K directly
 *
 * minScore semantics:
 *   Applied only to raw vector similarity scores (cosine, 0–1 range).
 *   NOT applied after reranking: cross-encoder scores are model-specific
 *   and not calibrated to the same scale; thresholding would silently
 *   drop relevant results when the reranker's score distribution is low.
 *
 * minResultScore semantics:
 *   Applied to final normalized scores (0–1, relative to the top result).
 *   Filters out results that are trivially irrelevant compared to the best
 *   match. Safe for all pipelines because it operates on the relative scale.
 */

import type { RerankResult, SeekxClient } from "./client.ts";
import type { RawResult, Store } from "./store.ts";
import { buildFTSQuery } from "./tokenizer.ts";

const RRF_K = 60;
const TOP_RANK_BONUS_FIRST = 0.05; // document ranked #1 in any list
const TOP_RANK_BONUS_TOP3 = 0.02; // document ranked #2–3 in any list

export interface SearchOptions {
  collections?: string[];
  limit?: number;
  minScore?: number;
  /** Minimum *normalized* score (0–1, relative to top result) for inclusion. */
  minResultScore?: number;
  mode?: "hybrid" | "bm25" | "vector";
  useRerank?: boolean;
  useExpand?: boolean;
  /**
   * When true, generate a hypothetical answer document via the LLM and embed
   * it as an additional vector query (HyDE — Hypothetical Document Embeddings).
   * Requires the expand endpoint to be configured. Off by default.
   */
  useHyde?: boolean;
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
  | { phase: "hyde_start"; query: string }
  | { phase: "hyde_done"; success: boolean }
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
// Weighted result list — used internally by rrfFuse
// ---------------------------------------------------------------------------

interface WeightedList {
  results: RawResult[];
  /** RRF contribution multiplier. Original query = 2, expanded queries = 1. */
  weight: number;
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
  const minScore =
    typeof opts.minScore === "number" && Number.isFinite(opts.minScore)
      ? Math.min(1, Math.max(0, opts.minScore))
      : 0;
  const minResultScore =
    typeof opts.minResultScore === "number" && Number.isFinite(opts.minResultScore)
      ? Math.min(1, Math.max(0, opts.minResultScore))
      : 0;
  const mode = opts.mode ?? "hybrid";
  const useRerank = opts.useRerank ?? true;
  const useExpand = opts.useExpand ?? true;
  const useHyde = opts.useHyde ?? false;
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
      // Always keep the original query at index 0 so BM25/vector recall is
      // never worse than without expansion, even if the LLM returns rewrites
      // that omit the original terms. Deduplicate to avoid redundant searches.
      const seen = new Set([query]);
      for (const q of expanded) {
        if (!seen.has(q)) {
          seen.add(q);
          expandedQueries.push(q);
        }
      }
    }
    // No warning if expand unavailable — degradation is transparent.
    onProgress?.({ phase: "expand_done", expandedQueries });
  }

  // --- Step 2: BM25 + Vector for each expanded query ---
  // Original query (index 0) uses weight=2 in RRF; expanded variants use weight=1.
  const candidateLimit = Math.max(limit * 4, 40);
  const allRawResults: Array<WeightedList & { listId: string }> = [];

  if (mode === "hybrid" || mode === "bm25") {
    onProgress?.({ phase: "bm25_start", totalQueries: expandedQueries.length });
    for (const [i, q] of expandedQueries.entries()) {
      const ftsQuery = buildFTSQuery(q);
      onProgress?.({ phase: "bm25_progress", completed: i + 1, totalQueries: expandedQueries.length, query: q });
      if (!ftsQuery) continue;
      try {
        const results = store.searchFTS(ftsQuery, candidateLimit, collections);
        allRawResults.push({ results, listId: `bm25-${i}`, weight: i === 0 ? 2 : 1 });
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
      const results = store
        .searchVector(vecs[0], candidateLimit, collections)
        .filter((raw) => raw.score >= minScore);
      if (results.length > 0) {
        allRawResults.push({ results, listId: `vec-${i}`, weight: i === 0 ? 2 : 1 });
      }
    }
  }

  // --- Step 3: HyDE (Hypothetical Document Embedding) ---
  // Generate a synthetic answer passage and search with its embedding.
  // Adds as an extra vector-only list with weight=1.
  if (useHyde && (mode === "hybrid" || mode === "vector") && client) {
    onProgress?.({ phase: "hyde_start", query });
    const hydeDoc = await client.hyde(query);
    onProgress?.({ phase: "hyde_done", success: hydeDoc !== null });
    if (hydeDoc) {
      const hydeVecs = await client.embed([hydeDoc]);
      if (hydeVecs?.[0]) {
        const hydeResults = store
          .searchVector(hydeVecs[0], candidateLimit, collections)
          .filter((raw) => raw.score >= minScore);
        if (hydeResults.length > 0) {
          allRawResults.push({ results: hydeResults, listId: "hyde", weight: 1 });
        }
      }
    }
  }

  if (allRawResults.length === 0) {
    onProgress?.({ phase: "done", resultCount: 0, warningCount: warnings.length });
    return { results: [], expandedQueries, warnings };
  }

  // --- Step 4: RRF fusion with original-query weighting and top-rank bonus ---
  const fused = rrfFuse(allRawResults);
  const topCandidates = fused.slice(0, candidateLimit);

  // --- Step 5: Position-aware rerank ---
  let finalRaw = topCandidates;
  if (useRerank && client && topCandidates.length > 1) {
    onProgress?.({ phase: "rerank_start", candidateCount: topCandidates.length });
    const reranked = await client.rerank(
      query,
      topCandidates.map((r) => r.content),
    );
    if (reranked) {
      // Use position-aware blending instead of pure replacement so that
      // top RRF results (exact matches, high BM25 confidence) are protected
      // from the reranker overriding them when it's wrong about niche terms.
      finalRaw = positionAwareBlend(topCandidates, reranked);
    }
    onProgress?.({
      phase: "rerank_done",
      candidateCount: topCandidates.length,
      applied: reranked !== null,
    });
  }

  // --- Step 6: Format results ---
  // Build FTS query for snippet extraction using the original user query
  // (not the expanded variants) so highlighted terms match what the user typed.
  const snippetFtsQuery = buildFTSQuery(query);
  const topScore = finalRaw[0]?.score ?? 1;
  const sliced = finalRaw.slice(0, limit);
  const results: SearchResult[] = sliced
    .map((raw) => ({
      docid: store.encodeDocid(raw.doc_id),
      chunk_id: raw.chunk_id,
      file: raw.path,
      title: raw.title,
      collection: raw.collection,
      score: normalizeScore(raw.score, topScore),
      // FTS5 snippet() finds the densest multi-term match window; falls back
      // to the custom extractor for vector-only results that aren't in FTS.
      snippet:
        (snippetFtsQuery ? store.getSnippetFTS(raw.chunk_id, snippetFtsQuery) : null) ??
        extractSnippet(raw.content, query, 180),
      start_line: raw.start_line,
      end_line: raw.end_line,
    }))
    .filter((r) => r.score >= minResultScore);

  onProgress?.({ phase: "done", resultCount: results.length, warningCount: warnings.length });

  return {
    results,
    expandedQueries: expandedQueries.length > 1 ? expandedQueries : [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// RRF implementation — weighted lists + top-rank bonus
// ---------------------------------------------------------------------------

function rrfFuse(lists: WeightedList[]): RawResult[] {
  // Single-list fast path: RRF would replace every score with weight/(k+rank+1),
  // discarding actual similarity values (cosine sim, BM25 rank, etc.).
  // For a single source, preserve the original scores so the caller gets
  // meaningful values (e.g. cosine similarity for pure vector search).
  if (lists.length === 1) {
    return [...(lists[0]?.results ?? [])].sort((a, b) => b.score - a.score);
  }

  // Score map: chunk_id → { rrfScore, topRankBonus, raw }
  const scoreMap = new Map<number, { score: number; bonus: number; raw: RawResult }>();

  for (const { results, weight } of lists) {
    // Sort each list by score descending to assign ranks.
    const sorted = [...results].sort((a, b) => b.score - a.score);
    for (let rank = 0; rank < sorted.length; rank++) {
      const raw = sorted[rank];
      if (!raw) continue;
      const rrfContrib = weight / (RRF_K + rank + 1);
      // Top-rank bonus: preserve strong per-source signals.
      const bonus =
        rank === 0 ? TOP_RANK_BONUS_FIRST : rank <= 2 ? TOP_RANK_BONUS_TOP3 : 0;
      const existing = scoreMap.get(raw.chunk_id);
      if (existing) {
        existing.score += rrfContrib;
        existing.bonus = Math.max(existing.bonus, bonus);
      } else {
        scoreMap.set(raw.chunk_id, { score: rrfContrib, bonus, raw });
      }
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.score + b.bonus - (a.score + a.bonus))
    .map(({ score, bonus, raw }) => ({ ...raw, score: score + bonus }));
}

// ---------------------------------------------------------------------------
// Position-aware rerank blending
// ---------------------------------------------------------------------------

/**
 * Blend RRF scores and cross-encoder scores based on the candidate's position
 * in the RRF-sorted list. High-RRF-ranked documents are harder to demote,
 * preventing the reranker from overriding strong exact-match signals.
 *
 * The `index` field of each RerankResult refers to the document's position in
 * `candidates[]` (which is already sorted by RRF score descending), so it
 * doubles as the RRF rank for blending weight selection.
 */
function positionAwareBlend(candidates: RawResult[], reranked: RerankResult[]): RawResult[] {
  const rrfTopScore = candidates[0]?.score ?? 1;
  const rerankerTopScore = Math.max(...reranked.map((r) => r.score), 1e-9);

  return reranked
    .flatMap(({ index, score }) => {
      const raw = candidates[index];
      if (!raw) return [];
      // index == RRF rank (candidates is sorted by RRF score descending).
      const rrfWeight = index < 3 ? 0.75 : index < 10 ? 0.6 : 0.4;
      const normRrf = rrfTopScore > 0 ? raw.score / rrfTopScore : 0;
      const normRerank = rerankerTopScore > 0 ? score / rerankerTopScore : 0;
      const blended = rrfWeight * normRrf + (1 - rrfWeight) * normRerank;
      return [{ ...raw, score: blended }];
    })
    .sort((a, b) => b.score - a.score);
}

function normalizeScore(score: number, topScore: number): number {
  return topScore > 0 ? Math.min(1, score / topScore) : 0;
}

// ---------------------------------------------------------------------------
// Snippet extraction (fallback when FTS5 snippet() is unavailable)
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
