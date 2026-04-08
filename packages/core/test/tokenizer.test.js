import { describe, expect, test } from "bun:test";
import { buildFTSQuery, expandForFTS } from "../src/tokenizer.ts";
describe("expandForFTS", () => {
    test("returns original + tokens for Chinese text", () => {
        const result = expandForFTS("数据库连接");
        // Must contain the original phrase
        expect(result).toContain("数据库连接");
        // And at least one token
        expect(result.split(" ").length).toBeGreaterThan(1);
    });
    test("returns unchanged for pure ASCII text", () => {
        const result = expandForFTS("hello world");
        expect(result).toBe("hello world");
    });
    test("mixed Chinese + English retains original", () => {
        const result = expandForFTS("search引擎");
        expect(result).toContain("search引擎");
    });
});
describe("buildFTSQuery", () => {
    test("single ASCII word → quoted", () => {
        const q = buildFTSQuery("database");
        expect(q).toBe('"database"');
    });
    test("multi-token Chinese query → OR expression", () => {
        const q = buildFTSQuery("向量数据库检索");
        expect(q).toContain("OR");
        // Original phrase must appear as one of the OR terms
        expect(q).toContain("向量数据库检索");
    });
    test("empty input → empty string", () => {
        expect(buildFTSQuery("")).toBe("");
        expect(buildFTSQuery("   ")).toBe("");
    });
    test("no duplicate tokens in OR expression", () => {
        const q = buildFTSQuery("数据库");
        // If jieba returns only one segment matching the whole input, no duplicates
        const parts = q.split(" OR ");
        const uniq = new Set(parts);
        expect(uniq.size).toBe(parts.length);
    });
});
//# sourceMappingURL=tokenizer.test.js.map