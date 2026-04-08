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
    const mag = Math.sqrt(n[0]! * n[0]! + n[1]! * n[1]!);
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
    n.forEach((x) => expect(isFinite(x)).toBe(true));
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
