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

describe("SeekxClient.expand — JSON parsing", () => {
  const embedCfg = { baseUrl: "http://127.0.0.1:1", apiKey: "", model: "x" };
  const expandCfg = { baseUrl: "https://example.com", apiKey: "k", model: "gpt-4o-mini" };

  function mockExpandFetch(content: string): typeof fetch {
    return createMockFetch({
      choices: [{ message: { content } }],
    });
  }

  test("parses bare JSON array", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('["alt query one", "alt query two"]');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("original");
    globalThis.fetch = prev;
    expect(result).toEqual(["original", "alt query one", "alt query two"]);
  });

  test("parses JSON array wrapped in ```json...``` fence", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('```json\n["rewrite one", "rewrite two"]\n```');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("query");
    globalThis.fetch = prev;
    expect(result).toEqual(["query", "rewrite one", "rewrite two"]);
  });

  test("parses JSON array wrapped in plain ``` fence", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('```\n["variant a", "variant b"]\n```');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("q");
    globalThis.fetch = prev;
    expect(result).toEqual(["q", "variant a", "variant b"]);
  });

  test("deduplicates original query from alternatives", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('["original", "other"]');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("original");
    globalThis.fetch = prev;
    expect(result).toEqual(["original", "other"]);
  });

  test("parses alternatives wrapped in an object", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('{"alternatives":["同义改写", "相关表述"]}');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("挺好");
    globalThis.fetch = prev;
    expect(result).toEqual(["挺好", "同义改写", "相关表述"]);
  });

  test("returns null on invalid JSON (fail-open)", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch("not json at all");
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("query");
    globalThis.fetch = prev;
    expect(result).toBeNull();
  });

  test("returns null when parsed JSON is not an alternatives array", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('{"alternatives":"not-an-array"}');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("query");
    globalThis.fetch = prev;
    expect(result).toBeNull();
  });

  test("treats an empty object response as silent fail-open", async () => {
    const prevFetch = globalThis.fetch;
    const prevError = console.error;
    const errors: string[] = [];
    globalThis.fetch = mockExpandFetch("{}");
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const client = new SeekxClient(embedCfg, null, expandCfg);
      const result = await client.expand("query");
      expect(result).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      globalThis.fetch = prevFetch;
      console.error = prevError;
    }
  });

  test("tolerates null items mixed into the alternatives array", async () => {
    // Some models return ["q1", null, "q2"]; we should keep the valid strings.
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('["good query", null, "another query"]');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("original");
    globalThis.fetch = prev;
    expect(result).toEqual(["original", "good query", "another query"]);
  });

  test("tolerates empty string items in the alternatives array", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('["q1", "", "q2"]');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("orig");
    globalThis.fetch = prev;
    expect(result).toEqual(["orig", "q1", "q2"]);
  });

  test("parses less common wrapper keys (expanded_queries, suggestions)", async () => {
    for (const key of ["expanded_queries", "suggestions"]) {
      const prev = globalThis.fetch;
      globalThis.fetch = mockExpandFetch(JSON.stringify({ [key]: ["alt1", "alt2"] }));
      const client = new SeekxClient(embedCfg, null, expandCfg);
      const result = await client.expand("base");
      globalThis.fetch = prev;
      expect(result).toEqual(["base", "alt1", "alt2"]);
    }
  });

  test("extracts JSON array embedded in prose via regex fallback", async () => {
    // Some models prepend a sentence before the JSON.
    const prev = globalThis.fetch;
    globalThis.fetch = mockExpandFetch('Here are the queries: ["rewrite one", "rewrite two"]');
    const client = new SeekxClient(embedCfg, null, expandCfg);
    const result = await client.expand("query");
    globalThis.fetch = prev;
    expect(result).toEqual(["query", "rewrite one", "rewrite two"]);
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
