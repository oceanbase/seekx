# Skill: Using seekx memory search in OpenClaw

seekx is installed as the OpenClaw memory backend.
`memory_search` and `memory_get` now route through seekx's search pipeline:
BM25 full-text by default, with vector kNN, cross-encoder reranking, and query
expansion enabled when the required models and runtime support are available.

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

## How to search

Use natural language queries, not keywords. When configured, seekx handles
query expansion and semantic matching internally; otherwise it falls back to
BM25-only search.

Good queries:
```
memory_search("Alice's role at Acme Corp and her preferred communication style")
memory_search("why we chose PostgreSQL over MySQL for the billing service")
memory_search("架构评审会议上的决定")
```

Less effective (but still works):
```
memory_search("Alice Acme")
memory_search("PostgreSQL MySQL")
```

---

## Search options

```typescript
memory_search(query: string, opts?: {
  limit?: number;       // default: 6; increase for broad topics, decrease for precision
  collection?: string;  // restrict to a named collection (see below)
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
- `content` — the matched text excerpt
- `score` — relevance score (0–1); above 0.5 is a strong match
- `collection` — which indexed directory the file is from

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

Example response pattern:
> Based on your notes (`~/notes/projects/acme.md`), the Acme project's API
> uses JWT tokens with a 24-hour expiry. The authentication flow is described
> in the architecture document (`~/projects/docs/auth.md`).
