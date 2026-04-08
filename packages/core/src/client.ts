/**
 * client.ts — OpenAI-compatible REST client for embed / rerank / expand.
 *
 * All three methods return null instead of throwing on network or API errors,
 * allowing callers (indexer, search pipeline) to degrade gracefully.
 *
 * Rerank API format differs between providers:
 *   SiliconFlow / Jina  →  documents: string[]
 *   Cohere              →  documents: [{ text: string }]
 *
 * Embeddings are L2-normalized before being returned so callers can use L2
 * distance directly (equivalent to cosine similarity on unit vectors).
 */

import type { ServiceEndpoint } from "./config.ts";

const REQUEST_TIMEOUT_MS = 30_000;

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
   */
  async rerank(query: string, documents: string[]): Promise<RerankResult[] | null> {
    if (!this.rerank_cfg) return null;
    if (documents.length === 0) return [];

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
          `[seekx] rerank: could not map results to input documents (missing index/document fields).`,
        );
        return null;
      }

      return mapped.sort((a, b) => b.score - a.score);
    } catch (e) {
      console.error(`[seekx] rerank request failed: ${e}`);
      return null;
    }
  }

  /**
   * Expand a query into 2–3 alternative formulations via chat completions.
   * Returns an array of query strings (including the original), or null on failure.
   */
  async expand(query: string): Promise<string[] | null> {
    if (!this.expand_cfg) return null;

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
      const content = data.choices[0]?.message.content ?? "[]";
      const alternatives = JSON.parse(content) as string[];
      // Always include the original query.
      return [query, ...alternatives.filter((q) => q !== query)];
    } catch (e) {
      console.error(`[seekx] expand request failed: ${e}`);
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
