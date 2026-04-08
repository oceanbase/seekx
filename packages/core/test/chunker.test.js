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
        if (withH) {
            expect(withH.embeddingContent).toContain(withH.heading_path);
        }
    });
    test("long document produces multiple chunks", () => {
        const chunks = chunkDocument(MD_LONG);
        expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
    test("no chunk has empty content", () => {
        const chunks = chunkDocument(MD_SIMPLE);
        chunks.forEach((c) => expect(c.content.length).toBeGreaterThan(0));
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
        chunks.forEach((c) => expect(c.heading_path).toBeNull());
    });
});
//# sourceMappingURL=chunker.test.js.map