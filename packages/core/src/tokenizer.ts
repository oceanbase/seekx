/**
 * tokenizer.ts — Chinese tokenization for FTS5.
 *
 * FTS5 built-in tokenizers (unicode61, ascii) do not segment Chinese text.
 * Registering a custom C tokenizer requires a native extension, breaking the
 * zero-compile promise.
 *
 * Workaround: pre-tokenize at write time by appending jieba segments after
 * the original text. FTS5 then indexes both, enabling exact-match phrase
 * search on the original AND single-token recall on the jieba segments.
 *
 *   original:  "数据库连接池的最佳实践"
 *   expanded:  "数据库连接池的最佳实践 数据库 连接 池 最佳 实践"
 *
 * At search time, buildFTSQuery() applies the same expansion and constructs
 * an FTS5 OR expression for maximum recall:
 *
 *   query "数据库连接" → fts5: "数据库连接 OR 数据库 OR 连接"
 */

import { cut } from "@node-rs/jieba";

/**
 * Expand text with jieba tokens for FTS5 indexing.
 * The original text is preserved so phrase and exact-match queries still work.
 */
export function expandForFTS(text: string): string {
  if (!containsHan(text)) return text;

  const tokens = segmentChinese(text);
  if (tokens.length === 0) return text;

  const uniqueTokens = dedupeTokens(tokens).filter((token) => token !== text);
  if (uniqueTokens.length === 0) return text;

  return `${text} ${uniqueTokens.join(" ")}`;
}

/**
 * Build an FTS5 MATCH expression from a user query.
 * Returns an OR-joined expression covering the full query plus each segment.
 */
export function buildFTSQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  if (!containsHan(trimmed)) return escapeFTS5(trimmed);

  const tokens = segmentChinese(trimmed);
  if (tokens.length <= 1) return escapeFTS5(trimmed);

  const parts = [escapeFTS5(trimmed), ...dedupeTokens(tokens).map(escapeFTS5)];
  const unique = dedupeTokens(parts);
  return unique.join(" OR ");
}

/**
 * Segment text with jieba (precise mode). Returns non-whitespace tokens only.
 * Pure-ASCII segments are returned as-is (jieba handles them correctly but
 * filtering whitespace tokens removes noise from mixed-language text).
 */
function segmentChinese(text: string): string[] {
  return cut(text, true).filter((t) => t.trim().length > 0);
}

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }

  return unique;
}

function containsHan(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

/**
 * Escape a phrase for FTS5: wrap in double-quotes to treat as a phrase query.
 * Internal quotes are doubled per FTS5 spec.
 */
function escapeFTS5(term: string): string {
  const escaped = term.replace(/"/g, '""');
  return `"${escaped}"`;
}
