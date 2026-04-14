import type { AutoRecallConfig } from "./config.ts";
import type { MemorySearchManager, MemorySearchResult } from "openclaw/plugin-sdk/plugin-entry";

export type AutoRecallDecisionReason =
  | "disabled"
  | "non_user_trigger"
  | "prompt_too_short"
  | "explicit_memory_tool_call"
  | "non_memory_prompt"
  | "memory_prompt";

export interface AutoRecallDecision {
  shouldRun: boolean;
  reason: AutoRecallDecisionReason;
  normalizedPrompt: string;
}

export interface AutoRecallRunResult {
  query: string;
  injectedContext: string | null;
  consideredResults: number;
  injectedResults: number;
  topScore: number | null;
}

const RECALL_PATTERNS = [
  /之前|以前|记得|记录过|说过|提到过|决定过|偏好|喜好|待办|架构设计决策|架构决策/u,
  /\bremember(ed)?\b/i,
  /\bprevious(ly)?\b/i,
  /\bbefore\b/i,
  /\bearlier\b/i,
  /\bdecid(e|ed)\b/i,
  /\bwe decided\b/i,
  /\bpreferences?\b/i,
  /\btodos?\b/i,
  /\bwhat did (i|we) say\b/i,
  /\bsearch (my|our) (memory|notes)\b/i,
];

const SKIP_PATTERNS = [
  /^memory_search\s*\(/i,
  /^memory_get\s*\(/i,
  /^openclaw\b/i,
  /^seekx\b/i,
  /^HEARTBEAT_OK$/i,
  /^Read HEARTBEAT\.md\b/i,
];

export function inspectAutoRecallPrompt(
  prompt: string,
  config: AutoRecallConfig,
  trigger?: string,
): AutoRecallDecision {
  const normalized = normalizePrompt(prompt);

  if (!config.enabled) {
    return {
      shouldRun: false,
      reason: "disabled",
      normalizedPrompt: normalized,
    };
  }
  if (trigger && trigger !== "user") {
    return {
      shouldRun: false,
      reason: "non_user_trigger",
      normalizedPrompt: normalized,
    };
  }
  if (!normalized || normalized.length < config.minQueryLength) {
    return {
      shouldRun: false,
      reason: "prompt_too_short",
      normalizedPrompt: normalized,
    };
  }
  if (SKIP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      shouldRun: false,
      reason: "explicit_memory_tool_call",
      normalizedPrompt: normalized,
    };
  }
  if (!RECALL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      shouldRun: false,
      reason: "non_memory_prompt",
      normalizedPrompt: normalized,
    };
  }

  return {
    shouldRun: true,
    reason: "memory_prompt",
    normalizedPrompt: normalized,
  };
}

export function shouldAutoRecall(prompt: string, config: AutoRecallConfig, trigger?: string): boolean {
  return inspectAutoRecallPrompt(prompt, config, trigger).shouldRun;
}

export function buildAutoRecallQuery(prompt: string): string {
  const normalized = normalizePrompt(prompt);
  if (!normalized) return "";
  if (/之前|以前|记得|记录过|说过|提到过|决定过/u.test(normalized)) return normalized;
  if (containsCjk(normalized)) return `之前记录的 ${normalized}`;
  if (normalized.length <= 24) return `previously recorded ${normalized}`;
  return normalized;
}

export async function runAutoRecall(params: {
  manager: MemorySearchManager;
  prompt: string;
  config: AutoRecallConfig;
}): Promise<AutoRecallRunResult> {
  const query = buildAutoRecallQuery(params.prompt);
  if (!query) {
    return {
      query,
      injectedContext: null,
      consideredResults: 0,
      injectedResults: 0,
      topScore: null,
    };
  }

  const rawResults = await params.manager.search(query, { limit: params.config.maxResults * 3 });
  const filtered = selectRecallResults(rawResults, params.config);
  const injectedContext = formatAutoRecallContext(filtered, params.config.maxChars);

  return {
    query,
    injectedContext,
    consideredResults: rawResults.length,
    injectedResults: filtered.length,
    topScore: filtered[0]?.score ?? null,
  };
}

function selectRecallResults(
  rawResults: MemorySearchResult[],
  config: AutoRecallConfig,
): MemorySearchResult[] {
  const deduped = new Map<string, MemorySearchResult>();

  for (const result of rawResults) {
    if (result.score < config.minScore) continue;
    const key = result.path;
    const existing = deduped.get(key);
    if (!existing || result.score > existing.score) {
      deduped.set(key, result);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, config.maxResults);
}

export function formatAutoRecallContext(
  results: MemorySearchResult[],
  maxChars: number,
): string | null {
  if (results.length === 0) return null;

  const lines = [
    "Relevant memory matches from seekx:",
    "Use these only if they are relevant to the current question. If you need more detail, call `memory_get` for the matched path instead of broadly scanning workspace files.",
    "",
  ];

  let text = lines.join("\n");
  let injected = 0;

  for (const [index, result] of results.entries()) {
    const titleSuffix = result.title ? ` — ${result.title}` : "";
    const collectionSuffix = result.collection ? ` [${result.collection}]` : "";
    const snippet = compactSnippet(result.content);
    const block = [
      `${index + 1}. [score=${result.score.toFixed(2)}] ${result.path}${collectionSuffix}${titleSuffix}`,
      `   ${snippet}`,
      "",
    ].join("\n");

    if (text.length + block.length > maxChars) break;
    text += block;
    injected++;
  }

  if (injected === 0) return null;
  return text.trimEnd();
}

export function buildAutoRecallSystemGuidance(params: {
  query: string;
  injectedResults: number;
  topScore: number | null;
}): string {
  const lines = [
    "## Seekx AutoRecall Enforcement",
    "This turn was classified as a memory-recall request and `before_prompt_build` has already run seekx auto-recall.",
    `Auto-recall query: \`${params.query || "(empty)"}\`. Injected matches: ${params.injectedResults}. Top score: ${params.topScore?.toFixed(2) ?? "n/a"}.`,
    "Treat any injected seekx memory block as the primary recall context for this turn.",
    "Do not call `web_search`, and do not run broad `exec`, `find`, `grep`, `ls`, or direct `read` scans over `workspace/memory/` or the wider workspace as the first step.",
    "If the injected seekx context is insufficient, call `memory_search` before any file scan. Use `memory_get` only for a matched path you have already identified.",
  ];

  if (params.injectedResults === 0) {
    lines.push(
      "Auto-recall found no high-confidence injected matches. Even in that case, use `memory_search` first if you still need prior context; broad file scanning remains fallback-only.",
    );
  }

  return lines.join("\n");
}

function compactSnippet(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 280);
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/^[\s\-*]+/, "").replace(/\s+/g, " ").trim();
}

function containsCjk(input: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(input);
}
