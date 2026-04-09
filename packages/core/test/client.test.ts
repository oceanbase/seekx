/**
 * client.test.ts — Unit tests for SeekxClient and l2normalize.
 *
 * API calls are not tested here (no real endpoint in CI). We only test:
 *   - l2normalize correctness.
 *   - SeekxClient construction.
 *   - healthCheck returns null gracefully when endpoint is unreachable.
 */

import { describe, expect, test } from "bun:test";
import { SeekxClient, l2normalize } from "../src/client.ts";

function createMockFetch(body: unknown): typeof fetch {
  return Object.assign(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    globalThis.fetch,
  );
}

describe("l2normalize", () => {
  test("unit vector is unchanged (approx)", () => {
    const v = [1, 0, 0];
    const n = l2normalize(v);
    expect(n[0]).toBeCloseTo(1);
    expect(n[1]).toBeCloseTo(0);
    expect(n[2]).toBeCloseTo(0);
  });

  test("normalized vector has magnitude 1", () => {
    const v = [3, 4];
    const n = l2normalize(v);
    const [x = 0, y = 0] = n;
    const mag = Math.sqrt(x * x + y * y);
    expect(mag).toBeCloseTo(1, 6);
  });

  test("arbitrary vector normalization", () => {
    const v = [1, 2, 3];
    const n = l2normalize(v);
    const mag = Math.sqrt(n.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1, 6);
  });

  test("zero vector stays zero (no NaN)", () => {
    const v = [0, 0, 0];
    const n = l2normalize(v);
    for (const x of n) {
      expect(Number.isFinite(x)).toBe(true);
    }
  });
});

describe("SeekxClient construction", () => {
  test("can be instantiated without throwing", () => {
    const client = new SeekxClient(
      { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "nomic-embed-text" },
      null,
      null,
    );
    expect(client).toBeDefined();
  });
});

describe("SeekxClient.embed — unreachable endpoint", () => {
  test("returns null (fail-open) on network error", async () => {
    const client = new SeekxClient(
      { baseUrl: "http://127.0.0.1:1", apiKey: "", model: "test" },
      null,
      null,
    );
    const result = await client.embed(["hello"]);
    expect(result).toBeNull();
  });
});

describe("SeekxClient.healthCheck — unreachable endpoint", () => {
  test("returns ok: false for all services", async () => {
    const client = new SeekxClient(
      { baseUrl: "http://127.0.0.1:1", apiKey: "", model: "test" },
      null,
      null,
    );
    const health = await client.healthCheck();
    expect(health.embed?.ok).toBe(false);
    expect(health.rerank).toBeNull();
    expect(health.expand).toBeNull();
  });
});

describe("SeekxClient.rerank — response shapes", () => {
  const rerankCfg = {
    baseUrl: "https://example.com/api/paas/v4",
    apiKey: "k",
    model: "rerank-pro",
  };
  const embedCfg = { baseUrl: "http://127.0.0.1:1", apiKey: "", model: "x" };

  test("maps SiliconFlow-style index + relevance_score", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = createMockFetch({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.1 },
      ],
    });

    const client = new SeekxClient(embedCfg, rerankCfg, null);
    const out = await client.rerank("q", ["a", "b"]);
    globalThis.fetch = prev;

    expect(out).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
  });

  test("maps Zhipu-style document + relevance_score (no index field)", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = createMockFetch({
      results: [
        { document: "second", relevance_score: 0.88 },
        { document: "first", relevance_score: 0.12 },
      ],
    });

    const client = new SeekxClient(embedCfg, rerankCfg, null);
    const out = await client.rerank("q", ["first", "second"]);
    globalThis.fetch = prev;

    expect(out).toEqual([
      { index: 1, score: 0.88 },
      { index: 0, score: 0.12 },
    ]);
  });

  test("returns null when results cannot be aligned to documents", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = createMockFetch({
      results: [{ relevance_score: 0.5 }],
    });

    const client = new SeekxClient(embedCfg, rerankCfg, null);
    const out = await client.rerank("q", ["only"]);
    globalThis.fetch = prev;

    expect(out).toBeNull();
  });
});
