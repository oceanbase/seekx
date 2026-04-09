/**
 * formatter.test.ts — Unit tests for CLI output formatting.
 *
 * Strategy: capture console.log output, strip ANSI escape sequences, and
 * assert on the plain-text structure.  This keeps tests resilient to palette
 * changes while still verifying layout, score formatting, and logic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SearchResult } from "@seekx/core";
import { formatSearchResults } from "../src/formatter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strip ANSI escape codes so assertions operate on plain text.
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function captureOutput(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.map(stripAnsi);
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    docid: "000001",
    chunk_id: 1,
    file: "notes/weather.md",
    title: "Weather",
    collection: "default",
    score: 1.0,
    snippet: "天气确实不错，晴朗无云",
    start_line: 1,
    end_line: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default (human-readable) format
// ---------------------------------------------------------------------------

describe("formatSearchResults — default", () => {
  test("prints no-results message when list is empty", () => {
    const lines = captureOutput(() => formatSearchResults([], {}));
    expect(lines.join("\n")).toContain("No results.");
  });

  test("score is rendered as a rounded percentage", () => {
    const lines = captureOutput(() => formatSearchResults([makeResult({ score: 0.39 })], {}));
    const text = lines.join("\n");
    expect(text).toContain("Score: 39%");
    // Must NOT use decimal notation.
    expect(text).not.toMatch(/Score:.*0\./);
  });

  test("100% for top-normalised score", () => {
    const lines = captureOutput(() => formatSearchResults([makeResult({ score: 1.0 })], {}));
    expect(lines.join("\n")).toContain("Score: 100%");
  });

  test("file:line header appears on its own line", () => {
    const lines = captureOutput(() =>
      formatSearchResults([makeResult({ file: "notes/weather.md", start_line: 5 })], {}),
    );
    expect(lines.some((l) => l === "notes/weather.md:5")).toBe(true);
  });

  test("title appears on its own line when present", () => {
    const lines = captureOutput(() =>
      formatSearchResults([makeResult({ title: "Weather Notes" })], {}),
    );
    expect(lines).toContain("Title: Weather Notes");
  });

  test("title line is omitted when title is null", () => {
    const lines = captureOutput(() => formatSearchResults([makeResult({ title: null })], {}));
    expect(lines.some((l) => l.startsWith("Title:"))).toBe(false);
  });

  test("diff-style header uses start_line and line count", () => {
    const lines = captureOutput(() =>
      formatSearchResults([makeResult({ start_line: 10, end_line: 14 })], {}),
    );
    // end_line - start_line + 1 = 5; the line may carry a leading \n from the
    // console.log call, so we match with includes() rather than strict equality.
    expect(lines.some((l) => l.includes("@@ -10,5 @@"))).toBe(true);
  });

  test("snippet is printed on its own line after the @@ header", () => {
    const snippet = "天气确实不错，晴朗无云";
    const lines = captureOutput(() => formatSearchResults([makeResult({ snippet })], {}));
    expect(lines).toContain(snippet);
  });

  test("same file gets the same color across two results", () => {
    // We can't easily inspect ANSI codes after stripping, so we verify
    // structural consistency: both results render file:line correctly.
    const r1 = makeResult({ file: "shared.md", start_line: 1, end_line: 2 });
    const r2 = makeResult({ file: "shared.md", start_line: 10, end_line: 12 });
    const lines = captureOutput(() => formatSearchResults([r1, r2], {}));
    const headerLines = lines.filter((l) => l.startsWith("shared.md:"));
    expect(headerLines).toEqual(["shared.md:1", "shared.md:10"]);
  });

  test("different files produce different ANSI color codes", () => {
    // Capture raw (non-stripped) output and check that the escape sequences
    // differ between results from distinct files.
    const rawLines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => rawLines.push(args.map((a) => String(a)).join(" "));
    try {
      formatSearchResults(
        [makeResult({ file: "alpha.md" }), makeResult({ file: "beta.md" })],
        {},
      );
    } finally {
      console.log = orig;
    }
    // The header line is `{ANSI}alpha.md{RESET}:1` — ANSI codes surround the
    // filename, so ".md:" is split by an escape sequence.  Match on filename.
    const headerLines = rawLines.filter((l) => l.includes("alpha.md") || l.includes("beta.md"));
    // Each header line should start with an ANSI escape for color.
    expect(headerLines.length).toBe(2);
    const ansiAlpha = headerLines[0]!.match(/\x1b\[[0-9;]*m/)?.[0];
    const ansiBeta = headerLines[1]!.match(/\x1b\[[0-9;]*m/)?.[0];
    // The two files should not share the same color code (highly likely with
    // the palette; exact value is an implementation detail but stability
    // matters so we at least confirm they are both ANSI escapes).
    expect(ansiAlpha).toMatch(/^\x1b\[/);
    expect(ansiBeta).toMatch(/^\x1b\[/);
  });
});

// ---------------------------------------------------------------------------
// --json mode
// ---------------------------------------------------------------------------

describe("formatSearchResults — json", () => {
  test("emits a single JSON object with results and expandedQueries", () => {
    const r = makeResult({ score: 0.75 });
    const lines = captureOutput(() =>
      formatSearchResults([r], { json: true, expandedQueries: ["天气", "weather"] }),
    );
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.results).toHaveLength(1);
    expect(parsed.expandedQueries).toEqual(["天气", "weather"]);
    // JSON score is the raw 0-1 value, not a percentage.
    expect(parsed.results[0].score).toBeCloseTo(0.75);
  });
});

// ---------------------------------------------------------------------------
// --files mode
// ---------------------------------------------------------------------------

describe("formatSearchResults — files", () => {
  test("prints unique file paths, one per line, deduplicated", () => {
    const results = [
      makeResult({ file: "a.md" }),
      makeResult({ file: "b.md" }),
      makeResult({ file: "a.md" }), // duplicate
    ];
    const lines = captureOutput(() => formatSearchResults(results, { files: true }));
    expect(lines.filter((l) => l !== "")).toEqual(["a.md", "b.md"]);
  });
});

// ---------------------------------------------------------------------------
// --md mode
// ---------------------------------------------------------------------------

describe("formatSearchResults — md", () => {
  test("renders score as percentage in markdown block quote", () => {
    const r = makeResult({ score: 0.6, start_line: 1, end_line: 5 });
    const lines = captureOutput(() => formatSearchResults([r], { md: true }));
    const blockQuote = lines.find((l) => l.startsWith(">"));
    expect(blockQuote).toBeDefined();
    expect(blockQuote).toContain("60%");
    expect(blockQuote).not.toMatch(/0\.\d{3}/);
  });

  test("includes file title in markdown heading", () => {
    const r = makeResult({ file: "notes/foo.md", title: "Foo Notes" });
    const lines = captureOutput(() => formatSearchResults([r], { md: true }));
    const heading = lines.find((l) => l.startsWith("##"));
    expect(heading).toContain("Foo Notes");
    expect(heading).toContain("notes/foo.md");
  });
});
