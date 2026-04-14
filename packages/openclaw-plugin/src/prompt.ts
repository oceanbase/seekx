import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Prompt guidance injected when seekx owns the OpenClaw memory slot.
 *
 * Goal: make memory_search the default recall path for prior decisions,
 * preferences, dates, and other stored context, instead of broad file scans.
 */
export const buildSeekxMemoryPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasSearch = availableTools.has("memory_search");
  const hasGet = availableTools.has("memory_get");

  if (!hasSearch && !hasGet) return [];

  const lines = ["## Seekx Memory Recall"];

  if (hasSearch && hasGet) {
    lines.push(
      "For questions about prior work, remembered facts, past decisions, dates, people, preferences, or todos: call `memory_search` before answering. If a result is relevant, use `memory_get` only for the matched path to fetch the minimum additional context you need.",
    );
  } else if (hasSearch) {
    lines.push(
      "For questions about prior work, remembered facts, past decisions, dates, people, preferences, or todos: call `memory_search` before answering and answer from the highest-confidence matches.",
    );
  } else {
    lines.push(
      "For questions about prior work, remembered facts, past decisions, dates, people, preferences, or todos: use `memory_get` only for a specific indexed path you already know.",
    );
  }

  lines.push(
    "Do not scan `workspace/memory/`, run broad file listings, or read memory files directly as the first step when seekx memory tools are available. Direct file inspection is fallback-only after memory_search is unavailable, disabled, or returns no useful results.",
  );
  lines.push(
    "For recall-style questions, do not call `web_search`, and do not use `exec`, `find`, `grep`, `ls`, or broad `read` calls over workspace memory files as the first retrieval path.",
  );
  lines.push(
    "Use natural-language recall queries with context instead of short keywords. Good examples: `why we chose PostgreSQL over MySQL`, `架构设计决策 使用 Java 开发 Web 应用`, or `the meeting where we chose the web framework`.",
  );

  if (citationsMode === "off") {
    lines.push("Citations are disabled: do not mention file paths unless the user asks.");
  } else {
    lines.push("When helpful, cite the matched memory path so the user can verify the source.");
  }

  lines.push("");
  return lines;
};
