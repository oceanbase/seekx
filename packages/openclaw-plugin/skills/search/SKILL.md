# Skill: Seekx Memory Recall First

seekx is installed as the OpenClaw memory backend.
`memory_search` and `memory_get` now route through seekx's search pipeline:
BM25 full-text by default, with vector kNN, cross-encoder reranking, and query
expansion enabled when the required models and runtime support are available.

---

## Use this skill when

The user is asking about:

- Prior work or previously discussed decisions
- Remembered facts, preferences, people, dates, or todos
- Anything they asked you to "remember", "recall", "search in memory", or "check what I said before"
- Any topic that might already be written in `MEMORY.md`, `memory/*.md`, or another indexed seekx collection

This skill is for recall-first behavior. Use it before broad file inspection.

---

## First-step policy

If `memory_search` is available, it is the default first step for recall tasks.

1. Call `memory_search` before answering.
2. If a result looks relevant, use `memory_get` or direct file read only for the matched path.
3. Do not start with `find`, `ls`, or broad reads of `workspace/memory/`.
4. Only fall back to direct file scanning if `memory_search` is unavailable, disabled, or returns no useful results.

If relevant seekx memory matches are already injected into the prompt, use those
matches first. Call `memory_get` only when you need more detail from a matched
path.

---

## When to call `memory_search`

**Call proactively** before answering any query that might be answered by
stored context. Do not wait for the user to ask you to search — search first.

Call `memory_search` when the user's message involves:

- People (colleagues, contacts, companies, relationships)
- Past decisions, meetings, or discussions
- Projects, codebases, or technical systems the user has documented
- Concepts, definitions, or domain knowledge the user has written down
- Anything the user might have noted in `MEMORY.md` or a notes directory

**Do not call** `memory_search` for:
- General knowledge questions (use your built-in knowledge)
- Queries where the user has provided all the context inline
- Purely computational tasks (math, code generation from scratch)

---

## Trigger phrases

These are strong hints that you should recall with seekx first:

- "What did we decide before?"
- "Search what I recorded earlier"
- "Do you remember my preference?"
- "Check my notes about this"
- "请帮我搜索一下我之前记录的架构设计决策"
- "我之前是不是说过..."

---

## How to search

Use natural language queries, not keywords. When configured, seekx handles
query expansion and semantic matching internally; otherwise it falls back to
BM25-only search.

Good queries:
```
memory_search("Alice's role at Acme Corp and her preferred communication style")
memory_search("why we chose PostgreSQL over MySQL for the billing service")
memory_search("架构评审会议上的决定")
memory_search("之前记录的架构设计决策 使用 Java 开发 Web 应用")
```

Less effective (but still works):
```
memory_search("Alice Acme")
memory_search("PostgreSQL MySQL")
memory_search("架构设计决策")
```

When the user's wording is short or ambiguous, expand it into a natural recall query:

- User: "架构设计决策"
- Better query: `memory_search("之前记录的架构设计决策 使用 Java 开发 Web 应用")`

- User: "我之前怎么说 PostgreSQL 的"
- Better query: `memory_search("why we chose PostgreSQL and what we said about it before")`

---

## Search options

```typescript
memory_search(query: string, opts?: {
  limit?: number;       // default: 6; increase for broad topics, decrease for precision
  collection?: string;  // restrict to a named collection (see below)
  citations?: "auto" | "on" | "off";  // override config-level citations mode per request
})
```

---

## Scoping to a collection

If you know which directory the relevant content lives in, scope the search
to avoid noise from unrelated collections.

```
memory_search("API authentication flow", { collection: "docs" })
memory_search("John Smith", { collection: "notes" })
```

Collection names come from:
- `plugins.entries.seekx.config.paths[].name` in `~/.openclaw/openclaw.json`
- the built-in collection name `openclaw-memory` for OpenClaw's own memory files

Use `openclaw status` to confirm that seekx is active and that aggregate file
and chunk counts are non-zero after indexing.

---

## Retrieving a full document

Search results include a `path` field (absolute filesystem path).
Use `memory_get` to read the full file content when:
- You need more context than the snippet provides
- The user asks you to read a specific file from memory
- You want to check if a document has been updated since the snippet was indexed

```
memory_get("/Users/me/notes/people/alice.md")
```

Prefer paths that came from `memory_search` results. seekx only returns content
for files inside indexed collections; paths outside indexed scope resolve to an
empty string.

For readable indexed paths, `memory_get` reads the live file from disk rather
than the indexed snapshot, so it returns the current version.

---

## Interpreting results

Each result contains:
- `path` — source file (absolute path)
- `content` — the matched text excerpt, with a `Source: path#line` citation
  footer when citations are enabled (default: `"auto"`)
- `score` — relevance score (0–1); above 0.5 is a strong match
- `collection` — which indexed directory the file is from

When citations are enabled (`citations: "auto"` or `"on"` in plugin config),
the `content` field ends with a line like:

```
Source: /Users/me/notes/decision.md#12
```

This is compatible with QMD's citation format and helps the agent trace
provenance. Set `citations: "off"` in the plugin config to suppress the
footer — the `path` field is still available for manual citation.

If scores are all below 0.2, the query likely didn't match well.
Try rephrasing with more context, or check that the relevant files are in
an indexed collection (configured `paths[].name` or the built-in
`openclaw-memory` collection). `openclaw status` can confirm that the backend
is active and that indexing has completed.

---

## When search returns no results

Possible causes and actions:

| Cause | What to do |
|---|---|
| Initial indexing not finished (gateway just started) | Wait 15–30 seconds and retry |
| The content is not in any indexed collection | Tell the user the content is not indexed; suggest adding the directory |
| Query is too specific / uses exact names | Rephrase with context ("the meeting about X" instead of "X meeting notes") |
| Files use an unindexed extension | Only `*.md`, `*.txt`, `*.markdown` are indexed by default |

---

## CJK queries

Queries in Chinese, Japanese, or Korean work natively.
seekx uses Jieba-based tokenization for CJK text, which is superior to the
trigram approach used by OpenClaw's built-in backend.

```
memory_search("用户增长策略讨论")
memory_search("技術的な決定の理由")
```

---

## Combining with your own reasoning

After retrieving memory results, synthesize them with your own knowledge.
Cite the source file path so the user knows where the information came from.

If you found a good match through seekx, answer from it. Do not restart the
process with a broad workspace scan unless the search result is clearly
insufficient.

Example response pattern:
> Based on your notes (`~/notes/projects/acme.md`), the Acme project's API
> uses JWT tokens with a 24-hour expiry. The authentication flow is described
> in the architecture document (`~/projects/docs/auth.md`).
