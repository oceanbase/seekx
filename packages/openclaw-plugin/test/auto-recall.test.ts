import { describe, expect, test } from "bun:test";
import {
  buildAutoRecallSystemGuidance,
  buildAutoRecallQuery,
  formatAutoRecallContext,
  inspectAutoRecallPrompt,
  shouldAutoRecall,
} from "../src/auto-recall.ts";
import type { AutoRecallConfig } from "../src/config.ts";

const DEFAULTS: AutoRecallConfig = {
  enabled: true,
  maxResults: 3,
  minScore: 0.2,
  maxChars: 1200,
  minQueryLength: 4,
};

describe("shouldAutoRecall", () => {
  test("returns true for prior-decision prompts", () => {
    expect(shouldAutoRecall("请帮我搜索一下我之前记录的架构设计决策", DEFAULTS, "user")).toBe(
      true,
    );
    expect(shouldAutoRecall("what did we decide before about PostgreSQL", DEFAULTS, "user")).toBe(
      true,
    );
  });

  test("returns false for non-user triggers and obvious skip patterns", () => {
    expect(shouldAutoRecall("请帮我搜索一下我之前记录的架构设计决策", DEFAULTS, "heartbeat")).toBe(
      false,
    );
    expect(shouldAutoRecall('memory_search("架构设计决策")', DEFAULTS, "user")).toBe(false);
    expect(shouldAutoRecall("hi", DEFAULTS, "user")).toBe(false);
  });
});

describe("inspectAutoRecallPrompt", () => {
  test("returns a skip reason for explicit memory tool calls", () => {
    const decision = inspectAutoRecallPrompt('memory_search("架构设计决策")', DEFAULTS, "user");
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("explicit_memory_tool_call");
  });

  test("returns a run decision for recall-style prompts", () => {
    const decision = inspectAutoRecallPrompt(
      "请帮我搜索一下我之前记录的架构设计决策",
      DEFAULTS,
      "user",
    );
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toBe("memory_prompt");
  });
});

describe("buildAutoRecallQuery", () => {
  test("preserves explicit recall phrasing", () => {
    expect(buildAutoRecallQuery("请帮我搜索一下我之前记录的架构设计决策")).toBe(
      "请帮我搜索一下我之前记录的架构设计决策",
    );
  });

  test("expands short CJK prompts into recall-style queries", () => {
    expect(buildAutoRecallQuery("架构设计决策")).toBe("之前记录的 架构设计决策");
  });

  test("expands short English prompts into recall-style queries", () => {
    expect(buildAutoRecallQuery("postgresql choice")).toBe("previously recorded postgresql choice");
  });
});

describe("formatAutoRecallContext", () => {
  test("returns null for empty results", () => {
    expect(formatAutoRecallContext([], 500)).toBeNull();
  });

  test("formats concise injected context with citations", () => {
    const text = formatAutoRecallContext(
      [
        {
          path: "/memory/decision.md",
          content: "**架构设计决策**: 使用 Java 开发 Web 应用",
          score: 0.93,
          collection: "openclaw-memory",
          title: "Decision log",
        },
      ],
      600,
    );

    expect(text).toContain("Relevant memory matches from seekx");
    expect(text).toContain("/memory/decision.md");
    expect(text).toContain("score=0.93");
    expect(text).toContain("Java 开发 Web 应用");
  });

  test("respects total injection budget", () => {
    const text = formatAutoRecallContext(
      [
        {
          path: "/memory/decision.md",
          content:
            "A very long snippet ".repeat(30) + "about an earlier decision that should overflow.",
          score: 0.93,
          collection: "openclaw-memory",
          title: "Decision log",
        },
      ],
      80,
    );

    expect(text).toBeNull();
  });
});

describe("buildAutoRecallSystemGuidance", () => {
  test("builds strong recall-first guidance for the current turn", () => {
    const text = buildAutoRecallSystemGuidance({
      query: "请帮我搜索一下我之前记录的架构设计决策",
      injectedResults: 1,
      topScore: 0.91,
    });

    expect(text).toContain("Seekx AutoRecall Enforcement");
    expect(text).toContain("before_prompt_build");
    expect(text).toContain("Do not call `web_search`");
    expect(text).toContain("call `memory_search` before any file scan");
    expect(text).toContain("Top score: 0.91");
  });

  test("mentions memory_search fallback when autoRecall injects nothing", () => {
    const text = buildAutoRecallSystemGuidance({
      query: "架构设计决策",
      injectedResults: 0,
      topScore: null,
    });

    expect(text).toContain("no high-confidence injected matches");
    expect(text).toContain("use `memory_search` first");
  });
});
