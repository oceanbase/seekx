import { describe, expect, test } from "bun:test";
import { buildSeekxMemoryPromptSection } from "../src/prompt.ts";

describe("buildSeekxMemoryPromptSection", () => {
  test("returns no prompt section when memory tools are unavailable", () => {
    const lines = buildSeekxMemoryPromptSection({
      availableTools: new Set<string>(),
    });

    expect(lines).toEqual([]);
  });

  test("injects recall-first guidance when memory_search and memory_get are present", () => {
    const lines = buildSeekxMemoryPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "auto",
    });
    const text = lines.join("\n");

    expect(text).toContain("Seekx Memory Recall");
    expect(text).toContain("call `memory_search` before answering");
    expect(text).toContain("use `memory_get` only for the matched path");
    expect(text).toContain("Do not scan `workspace/memory/`");
    expect(text).toContain("do not call `web_search`");
    expect(text).toContain("架构设计决策 使用 Java 开发 Web 应用");
    expect(text).toContain("cite the matched memory path");
  });

  test("mentions citation suppression when citations are disabled", () => {
    const lines = buildSeekxMemoryPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    const text = lines.join("\n");

    expect(text).toContain("Citations are disabled");
    expect(text).toContain("call `memory_search` before answering");
  });
});
