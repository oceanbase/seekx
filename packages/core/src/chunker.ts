/**
 * chunker.ts — Markdown-aware document chunking.
 *
 * Splitting strategy:
 *   1. Parse Markdown headings (#–####) as preferred split boundaries.
 *   2. Merge small sections until TARGET_TOKENS is reached.
 *   3. Force-split sections that exceed HARD_CAP_TOKENS.
 *   4. Carry OVERLAP_TOKENS trailing context into the next chunk.
 *
 * Each chunk's embeddingContent prepends the heading_path so that embedding
 * captures structural context (e.g. "## Search Pipeline > ### Rerank\n\n…").
 *
 * For .txt files: split at blank lines only, no heading awareness.
 */

export interface Chunk {
  chunk_idx: number;
  content: string; // raw text stored in DB and sent to rerank
  embeddingContent: string; // heading_path + content, sent to embed API
  heading_path: string | null;
  start_line: number; // 1-based
  end_line: number; // 1-based, inclusive
  token_count: number; // estimated (chars / 4)
}

const TARGET_TOKENS = 900;
const HARD_CAP_TOKENS = 1024;
const OVERLAP_TOKENS = Math.floor(TARGET_TOKENS * 0.15); // ≈135

const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN; // 3600
const HARD_CAP_CHARS = HARD_CAP_TOKENS * CHARS_PER_TOKEN; // 4096
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // ≈540

const HEADING_RE = /^(#{1,4})\s+(.+)$/;

interface ParsedLine {
  num: number; // 1-based
  text: string;
  heading: { level: number; text: string } | null;
}

/**
 * Chunk a document into overlapping segments.
 *
 * @param content     Full file text.
 * @param isMarkdown  true for .md/.markdown files; false for .txt
 */
export function chunkDocument(content: string, isMarkdown = true): Chunk[] {
  if (!content.trim()) return [];

  const lines: ParsedLine[] = content.split("\n").map((text, i) => {
    const m = isMarkdown ? HEADING_RE.exec(text) : null;
    const headingLevel = m?.[1];
    const headingText = m?.[2];
    return {
      num: i + 1,
      text,
      heading:
        headingLevel && headingText
          ? { level: headingLevel.length, text: headingText.trim() }
          : null,
    };
  });

  const segments = isMarkdown ? buildMarkdownSegments(lines) : buildPlainSegments(lines);
  return segmentsToChunks(segments);
}

// ---------------------------------------------------------------------------
// Segment: a contiguous block of lines sharing a heading context
// ---------------------------------------------------------------------------

interface Segment {
  headingPath: string | null;
  lines: ParsedLine[];
}

function buildMarkdownSegments(lines: ParsedLine[]): Segment[] {
  const segments: Segment[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let current: ParsedLine[] = [];

  const flush = () => {
    if (current.length > 0) {
      segments.push({ headingPath: headingStackToPath(headingStack), lines: current });
      current = [];
    }
  };

  for (const line of lines) {
    if (line.heading) {
      flush();
      // Pop shallower-or-equal headings before pushing the new one.
      while (headingStack.length > 0) {
        const currentHeading = headingStack.at(-1);
        if (!currentHeading || currentHeading.level < line.heading.level) break;
        headingStack.pop();
      }
      headingStack.push(line.heading);
      current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return segments;
}

function buildPlainSegments(lines: ParsedLine[]): Segment[] {
  const segments: Segment[] = [];
  let current: ParsedLine[] = [];

  for (const line of lines) {
    if (line.text.trim() === "") {
      if (current.length > 0) {
        segments.push({ headingPath: null, lines: current });
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) segments.push({ headingPath: null, lines: current });
  return segments;
}

function headingStackToPath(stack: { level: number; text: string }[]): string | null {
  if (stack.length === 0) return null;
  return stack.map((h) => `${"#".repeat(h.level)} ${h.text}`).join(" > ");
}

// ---------------------------------------------------------------------------
// Convert segments to final chunks with overlap
// ---------------------------------------------------------------------------

function segmentsToChunks(segments: Segment[]): Chunk[] {
  const chunks: Chunk[] = [];
  let idx = 0;
  let overlapTail = ""; // trailing text from previous chunk

  for (const seg of segments) {
    const segText = seg.lines
      .map((l) => l.text)
      .join("\n")
      .trimEnd();
    if (!segText.trim()) continue;

    const start = seg.lines[0];
    const end = seg.lines.at(-1);
    if (!start || !end) continue;

    const startLine = start.num;
    const endLine = end.num;
    const body = overlapTail ? `${overlapTail}\n${segText}` : segText;

    if (body.length <= HARD_CAP_CHARS) {
      chunks.push(makeChunk(idx++, body, seg.headingPath, startLine, endLine));
      overlapTail = trailing(segText, OVERLAP_CHARS);
    } else {
      // Segment exceeds hard cap — split into sub-chunks.
      const sub = splitText(body, seg.headingPath, startLine, endLine, idx);
      chunks.push(...sub);
      idx += sub.length;
      const last = sub[sub.length - 1];
      overlapTail = last ? trailing(last.content, OVERLAP_CHARS) : "";
    }
  }

  return chunks;
}

function splitText(
  text: string,
  headingPath: string | null,
  startLine: number,
  endLine: number,
  startIdx: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  let idx = startIdx;
  const span = endLine - startLine;

  while (offset < text.length) {
    const slice = text.slice(offset, offset + TARGET_CHARS).trimEnd();
    if (!slice.trim()) break;

    const progress = span > 0 ? offset / text.length : 0;
    const lineEst = Math.round(startLine + progress * span);

    chunks.push(makeChunk(idx++, slice, headingPath, lineEst, endLine));

    // Advance to the next sub-chunk start, aligned to a word boundary.
    // Without this, fixed-size slicing would begin the next chunk mid-word
    // whenever TARGET_CHARS - OVERLAP_CHARS doesn't land on whitespace.
    const idealNext = offset + TARGET_CHARS - OVERLAP_CHARS;
    const aligned = wordAlignForward(text, idealNext);
    if (aligned <= offset) break; // guard: prevent infinite loop on very long words
    offset = aligned;
  }
  return chunks;
}

/**
 * Advance `idx` to the start of the next complete word (non-whitespace run)
 * at or after position `idx`. If `idx` is mid-word, advance past the current
 * word first; if already at whitespace, skip it directly.
 */
function wordAlignForward(text: string, idx: number): number {
  if (idx >= text.length) return text.length;
  // If mid-word, advance to end of the current word.
  if (!/\s/.test(text[idx] ?? "")) {
    while (idx < text.length && !/\s/.test(text[idx] ?? "")) idx++;
  }
  // Skip whitespace to reach the start of the next word.
  while (idx < text.length && /\s/.test(text[idx] ?? "")) idx++;
  return idx;
}

function makeChunk(
  idx: number,
  content: string,
  headingPath: string | null,
  startLine: number,
  endLine: number,
): Chunk {
  const trimmed = content.trim();
  const embeddingContent = headingPath ? `${headingPath}\n\n${trimmed}` : trimmed;
  return {
    chunk_idx: idx,
    content: trimmed,
    embeddingContent,
    heading_path: headingPath,
    start_line: startLine,
    end_line: endLine,
    token_count: Math.ceil(trimmed.length / CHARS_PER_TOKEN),
  };
}

/**
 * Return the last `chars` characters of `text`, aligned to the nearest
 * word boundary so the overlap never starts mid-word.
 *
 * Strategy: if the character at the cut point is already whitespace, trim
 * leading whitespace and return. Otherwise advance to the next space or
 * newline. This keeps the overlap trimmed and semantically clean.
 */
function trailing(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const idx = text.length - chars;
  // Already at whitespace — trim and return.
  if (/\s/.test(text[idx] ?? "")) return text.slice(idx).trimStart();
  // Advance to the next space or newline to avoid cutting mid-word.
  const nextSpace = text.indexOf(" ", idx);
  const nextNl = text.indexOf("\n", idx);
  let boundary: number;
  if (nextSpace === -1 && nextNl === -1) {
    boundary = text.length; // no boundary found; return empty overlap
  } else if (nextSpace === -1) {
    boundary = nextNl;
  } else if (nextNl === -1) {
    boundary = nextSpace;
  } else {
    boundary = Math.min(nextSpace, nextNl);
  }
  return text.slice(boundary).trimStart();
}
