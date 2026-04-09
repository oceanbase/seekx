/**
 * client.ts — OpenAI-compatible REST client for embed / rerank / expand / hyde.
 *
 * All four methods return null instead of throwing on network or API errors,
 * allowing callers (indexer, search pipeline) to degrade gracefully.
 *
 * Rerank API format differs between providers:
 *   SiliconFlow / Jina  →  documents: string[]
 *   Cohere              →  documents: [{ text: string }]
 *
 * Embeddings are L2-normalized before being returned so callers can use L2
 * distance directly (equivalent to cosine similarity on unit vectors).
 *
 * LLM response caching:
 *   An optional LLMCache can be injected at construction. When present:
 *   - expand() caches by (model, query); TTL 1 hour.
 *   - rerank() caches by (model, query, djb2 hash of documents); TTL 1 hour.
 *   - hyde() caches by (model, query); TTL 1 hour.
 *   The cache key is a plain string; the value is JSON-serialised response.
 */

import type { ServiceEndpoint } from "./config.ts";

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// LLM response cache interface
// ---------------------------------------------------------------------------

/**
 * Pluggable cache for LLM responses (expand, rerank, hyde).
 * The Store implementation uses an SQLite table; tests can inject a Map-backed stub.
 */
export interface LLMCache {
  get(key: string): string | null;
  set(key: string, value: string, ttlSec?: number): void;
}

export interface RerankResult {
  index: number;
  score: number;
}

// ---------------------------------------------------------------------------
// SeekxClient
// ---------------------------------------------------------------------------

export class SeekxClient {
  constructor(
    private readonly embed_cfg: ServiceEndpoint,
    private readonly rerank_cfg: ServiceEndpoint | null,
    private readonly expand_cfg: ServiceEndpoint | null,
    private readonly cache?: LLMCache,
  ) {}

  /**
   * Embed a batch of texts. Returns L2-normalized vectors, or null on failure.
   * The returned array is parallel to the input array.
   */
  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.embed_cfg.baseUrl || !this.embed_cfg.model) return null;
    if (texts.length === 0) return [];

    try {
      const res = await fetchWithTimeout(
        `${this.embed_cfg.baseUrl}/embeddings`,
        {
          method: "POST",
          headers: jsonHeaders(this.embed_cfg.apiKey),
          body: JSON.stringify({ model: this.embed_cfg.model, input: texts }),
        },
        REQUEST_TIMEOUT_MS,
      );

      if (!res.ok) {
        console.error(`[seekx] embed API error: ${res.status} ${await res.text()}`);
        return null;
      }

      const data = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Ensure ordering matches input (API may reorder).
      const sorted = data.data.slice().sort((a, b) => a.index - b.index);
      return sorted.map((d) => l2normalize(d.embedding));
    } catch (e) {
      console.error(`[seekx] embed request failed: ${e}`);
      return null;
    }
  }

  /**
   * Rerank documents against a query. Returns results sorted by score desc,
   * or null on failure. Each result contains the original index + score.
   * Responses are cached by (model, query, djb2 hash of documents).
   */
  async rerank(query: string, documents: string[]): Promise<RerankResult[] | null> {
    if (!this.rerank_cfg) return null;
    if (documents.length === 0) return [];

    const cacheKey = `rerank:${this.rerank_cfg.model}:${query}:${djb2Hash(documents)}`;
    const cached = this.cache?.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as RerankResult[];
      } catch {
        // Corrupted cache entry — fall through to API call.
      }
    }

    const isCohere = this.rerank_cfg.baseUrl.includes("cohere.com");
    const docs = isCohere ? documents.map((text) => ({ text })) : documents;

    try {
      const res = await fetchWithTimeout(
        `${this.rerank_cfg.baseUrl}/rerank`,
        {
          method: "POST",
          headers: jsonHeaders(this.rerank_cfg.apiKey),
          body: JSON.stringify({
            model: this.rerank_cfg.model,
            query,
            documents: docs,
            top_n: documents.length,
          }),
        },
        REQUEST_TIMEOUT_MS,
      );

      if (!res.ok) {
        console.error(`[seekx] rerank API error: ${res.status} ${await res.text()}`);
        return null;
      }

      const data = (await res.json()) as {
        results: Array<{
          index?: number;
          relevance_score?: number;
          score?: number;
          document?: string;
        }>;
      };

      const mapped: RerankResult[] = data.results
        .map((r) => {
          let index = -1;
          if (typeof r.index === "number" && Number.isFinite(r.index)) {
            index = r.index;
          } else if (typeof r.document === "string") {
            index = documents.indexOf(r.document);
          }
          const score = r.relevance_score ?? r.score ?? 0;
          return { index, score };
        })
        .filter((r) => r.index >= 0 && r.index < documents.length);

      if (mapped.length === 0 && data.results.length > 0) {
        console.error(
          "[seekx] rerank: could not map results to input documents (missing index/document fields).",
        );
        return null;
      }

      const sorted = mapped.sort((a, b) => b.score - a.score);
      this.cache?.set(cacheKey, JSON.stringify(sorted));
      return sorted;
    } catch (e) {
      console.error(`[seekx] rerank request failed: ${e}`);
      return null;
    }
  }

  /**
   * Expand a query into 2–3 alternative formulations via chat completions.
   * Returns an array of query strings (including the original), or null on failure.
   * Responses are cached by (model, query).
   */
  async expand(query: string): Promise<string[] | null> {
    if (!this.expand_cfg) return null;

    const cacheKey = `expand:${this.expand_cfg.model}:${query}`;
    const cached = this.cache?.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as string[];
      } catch {
        // Corrupted cache entry — fall through to API call.
      }
    }

    const systemPrompt =
      "You are a search query expansion assistant. " +
      "Given a user query, produce 2 alternative search queries that capture the same intent " +
      "using different vocabulary. Output ONLY a JSON array of strings, no explanation. " +
      'Example input: "k8s pod crash" ' +
      'Example output: ["kubernetes pod CrashLoopBackOff debug", "容器启动失败 排查步骤 日志"]';

    try {
      const res = await fetchWithTimeout(
        `${this.expand_cfg.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: jsonHeaders(this.expand_cfg.apiKey),
          body: JSON.stringify({
            model: this.expand_cfg.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: query },
            ],
            temperature: 0.3,
            max_tokens: 256,
          }),
        },
        REQUEST_TIMEOUT_MS,
      );

      if (!res.ok) {
        console.error(`[seekx] expand API error: ${res.status} ${await res.text()}`);
        return null;
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const raw = (data.choices[0]?.message.content ?? "[]").trim();
      // Strip optional markdown code fence that some models add (e.g. ```json…```).
      const stripped = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch {
        // JSON.parse failed; pass undefined so parseExpandAlternatives can
        // attempt regex extraction from the raw text.
        parsed = undefined;
      }
      const alternatives = parseExpandAlternatives(parsed, stripped);
      if (!alternatives) {
        if (shouldLogExpandParseFailure(parsed, stripped)) {
          console.error(
            `[seekx] expand API error: could not extract string alternatives. raw response: ${JSON.stringify(raw)}`,
          );
        }
        return null;
      }
      // Always include the original query.
      const result = [query, ...alternatives.filter((q) => q !== query)];
      this.cache?.set(cacheKey, JSON.stringify(result));
      return result;
    } catch (e) {
      console.error(`[seekx] expand request failed: ${e}`);
      return null;
    }
  }

  /**
   * Generate a Hypothetical Document Embedding (HyDE) passage for the query.
   * Returns a short synthetic passage that resembles what a relevant document
   * would say, enabling the embedding model to retrieve via document-space
   * similarity rather than query-space.
   * Reuses the expand endpoint. Responses are cached by (model, query).
   */
  async hyde(query: string): Promise<string | null> {
    if (!this.expand_cfg) return null;

    const cacheKey = `hyde:${this.expand_cfg.model}:${query}`;
    const cached = this.cache?.get(cacheKey);
    if (cached) return cached;

    const systemPrompt =
      "You are a document search expert. Given a search query, write a short passage " +
      "(2–4 sentences) that would be an ideal answer or highly relevant document fragment. " +
      "Write as factual document content, not as an assistant. Be specific and informative.";

    try {
      const res = await fetchWithTimeout(
        `${this.expand_cfg.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: jsonHeaders(this.expand_cfg.apiKey),
          body: JSON.stringify({
            model: this.expand_cfg.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: query },
            ],
            temperature: 0.7,
            max_tokens: 300,
          }),
        },
        REQUEST_TIMEOUT_MS,
      );

      if (!res.ok) {
        console.error(`[seekx] hyde API error: ${res.status} ${await res.text()}`);
        return null;
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const hydeDoc = data.choices[0]?.message.content?.trim() ?? null;
      if (hydeDoc) this.cache?.set(cacheKey, hydeDoc);
      return hydeDoc;
    } catch (e) {
      console.error(`[seekx] hyde request failed: ${e}`);
      return null;
    }
  }

  /**
   * Health check: verify all configured endpoints respond correctly.
   * Returns a map of service → { ok, latencyMs, dim? }.
   */
  async healthCheck(): Promise<
    Record<"embed" | "rerank" | "expand", { ok: boolean; latencyMs: number; dim?: number } | null>
  > {
    const results: Record<
      "embed" | "rerank" | "expand",
      { ok: boolean; latencyMs: number; dim?: number } | null
    > = { embed: null, rerank: null, expand: null };

    // Embed check
    if (this.embed_cfg.baseUrl) {
      const t = Date.now();
      const vecs = await this.embed(["health check"]);
      if (vecs) {
        const dim = vecs[0]?.length;
        results.embed =
          dim === undefined
            ? { ok: true, latencyMs: Date.now() - t }
            : { ok: true, latencyMs: Date.now() - t, dim };
      } else {
        results.embed = { ok: false, latencyMs: Date.now() - t };
      }
    }

    // Rerank check
    if (this.rerank_cfg) {
      const t = Date.now();
      const r = await this.rerank("test", ["doc a", "doc b"]);
      results.rerank = { ok: r !== null, latencyMs: Date.now() - t };
    }

    // Expand check
    if (this.expand_cfg) {
      const t = Date.now();
      const q = await this.expand("test query");
      results.expand = { ok: q !== null, latencyMs: Date.now() - t };
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * DJB2-based hash of an array of strings. Used to build rerank cache keys
 * without importing the crypto module. Fast and sufficient for cache
 * discrimination — not intended for security purposes.
 */
function djb2Hash(strs: string[]): string {
  let h = 5381;
  for (const s of strs) {
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Try every known shape the LLM might use to return expansion alternatives.
 * Falls back to regex extraction from the raw stripped text so that prose
 * preambles (e.g. "Here are your queries: [...]") are still handled.
 */
function parseExpandAlternatives(value: unknown, raw: string): string[] | null {
  // Direct array.
  if (Array.isArray(value)) {
    const result = sanitizeExpandAlternatives(value);
    if (result) return result;
  }

  // Object wrapper — try known keys then any array-valued property.
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of [
      "alternatives",
      "queries",
      "rewrites",
      "expanded_queries",
      "suggestions",
      "results",
      "items",
    ]) {
      const nested = obj[key];
      if (Array.isArray(nested)) {
        const result = sanitizeExpandAlternatives(nested);
        if (result) return result;
      }
    }
    // Generic fallback: try every array-valued property in declaration order.
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        const result = sanitizeExpandAlternatives(v);
        if (result) return result;
      }
    }
  }

  // Last resort: regex-extract the first JSON array literal from raw text.
  // Handles cases where the model wraps output in prose or the outer JSON.parse
  // failed entirely.
  const match = raw.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const extracted: unknown = JSON.parse(match[0]);
      if (Array.isArray(extracted)) return sanitizeExpandAlternatives(extracted);
    } catch {
      // not parseable; fall through to null
    }
  }

  return null;
}

/**
 * Filter an array down to non-empty strings.  We are intentionally lenient:
 * if the model mixes in a null or empty string we skip that item rather than
 * rejecting the entire batch.  Return null only if no valid string survives.
 */
function sanitizeExpandAlternatives(values: unknown[]): string[] | null {
  const out = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return out.length > 0 ? out : null;
}

function shouldLogExpandParseFailure(value: unknown, raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "[]" || trimmed === "{}" || trimmed === "null") {
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  if (value && typeof value === "object" && Object.keys(value).length === 0) {
    return false;
  }
  return true;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * L2-normalize a vector. Returns the original vector unchanged if its norm is 0.
 * Must be applied before inserting into vec_chunks so that L2 distance
 * in sqlite-vec is equivalent to cosine similarity.
 */
export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}
