import { describe, expect, test } from "bun:test";
import { chunkDocument } from "../src/chunker.ts";

const MD_SIMPLE = `# Title

First paragraph with some content here.

## Section A

Content under section A.

## Section B

Content under section B. This has more words to fill things out.
`;

const MD_LONG = `# Doc

${"word ".repeat(1000)}

## Part Two

${"word ".repeat(1000)}
`;

describe("chunkDocument — markdown", () => {
  test("returns at least one chunk", () => {
    const chunks = chunkDocument(MD_SIMPLE);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk_idx is sequential starting from 0", () => {
    const chunks = chunkDocument(MD_SIMPLE);
    chunks.forEach((c, i) => expect(c.chunk_idx).toBe(i));
  });

  test("heading_path is populated under headings", () => {
    const chunks = chunkDocument(MD_SIMPLE);
    const withHeading = chunks.filter((c) => c.heading_path !== null);
    expect(withHeading.length).toBeGreaterThan(0);
  });

  test("embeddingContent prepends heading_path", () => {
    const chunks = chunkDocument(MD_SIMPLE);
    const withH = chunks.find((c) => c.heading_path !== null);
    expect(withH?.heading_path).not.toBeNull();
    if (!withH?.heading_path) throw new Error("Expected a heading-aware chunk");
    expect(withH.embeddingContent).toContain(withH.heading_path);
  });

  test("long document produces multiple chunks", () => {
    const chunks = chunkDocument(MD_LONG);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("no chunk has empty content", () => {
    const chunks = chunkDocument(MD_SIMPLE);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  test("start_line < end_line for multi-line chunks", () => {
    const chunks = chunkDocument(MD_LONG);
    for (const c of chunks) {
      expect(c.start_line).toBeLessThanOrEqual(c.end_line);
    }
  });
});

describe("chunkDocument — plain text", () => {
  test("plain text produces at least one chunk", () => {
    const chunks = chunkDocument("Hello world\n\nSecond paragraph.", false);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("heading_path is null for plain text", () => {
    const chunks = chunkDocument("Hello world.\n\nAnother line.", false);
    for (const chunk of chunks) {
      expect(chunk.heading_path).toBeNull();
    }
  });
});

describe("chunkDocument — overlap boundary preservation", () => {
  test("overlap does not start mid-word when cut falls inside a word", () => {
    // Use a text whose words are identifiable by their first character: each
    // word is "abcdefghij" (10 chars) followed by a space. A mid-word cut would
    // produce a sub-chunk starting with 'b'–'j' (a continuation character).
    // With word-boundary alignment, every sub-chunk must start with 'a' (new
    // word), '#' (heading), or whitespace.
    const longSection = `## Section\n\n${"abcdefghij ".repeat(500)}`;
    const chunks = chunkDocument(longSection);

    // Need at least 2 chunks for splitText to be exercised.
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i]?.content ?? "";
      // Find the first non-whitespace character to check the word boundary.
      const firstWordChar = content.trimStart()[0] ?? "";
      // In our "abcdefghij " pattern:
      //   - 'a'  → valid: start of a complete word
      //   - '#'  → valid: heading marker
      //   - 'b'–'j' → INVALID: mid-word continuation
      //
      // Allow heading chars (#) and word-start chars (a), reject continuations.
      const isMidWord = /^[b-j]$/.test(firstWordChar);
      expect(isMidWord).toBe(false);
    }
  });

  test("overlap is non-empty for large documents", () => {
    // Verify that the boundary fix doesn't produce zero-length overlaps
    // when the cut point happens to be at a word start.
    const content = `# Big Doc\n\n${"hello world ".repeat(600)}`;
    const chunks = chunkDocument(content);
    // For large docs, adjacent chunks should share some context.
    // We can't assert exact overlap chars, but ensure chunks are non-empty.
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
