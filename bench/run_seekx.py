"""
run_seekx.py — Run seekx search for each MIRACL-zh query and collect ranked results.

For each query in queries.jsonl, this script invokes:
  seekx search --json --no-rerank --no-expand -n {top_k} "<query>"

Flags rationale
---------------
--no-rerank  Disables the cross-encoder reranker, which makes latency acceptable
             for 393 sequential queries. Run with --rerank to enable it (slow).
--no-expand  Disables LLM query expansion. Use --expand to enable (requires
             expand API to be configured).
-n {top_k}   Retrieve up to top_k results per query (default: 10).

The "file" field in each JSON result is the path relative to the collection
directory, e.g. "0_1234.md".  We strip the ".md" suffix and use docid_map.json
to reverse-map back to the original MIRACL docid for evaluation.

Outputs (appended to --out-dir):
  results_seekx.jsonl   One JSON object per query:
                          {query_id, query, hits: [{rank, doc_id, score, file}]}

Usage
-----
  python3 bench/run_seekx.py [--data-dir bench/data] [--top-k 10]
                             [--collection miracl-zh] [--rerank] [--expand]
                             [--seekx seekx]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time


def load_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def run_seekx(
    query: str,
    *,
    seekx_bin: str,
    collection: str,
    top_k: int,
    rerank: bool,
    expand: bool,
    min_score: float = 0.0,
) -> list[dict] | None:
    """
    Invoke seekx search and return the list of hits, or None on failure.

    seekx exits with code 1 when no results, 2 when API is degraded.
    Both cases are treated as valid (empty or partial results).
    """
    cmd = [seekx_bin, "search", "--json", "-n", str(top_k), "-c", collection,
           "--min-score", str(min_score)]
    if not rerank:
        cmd.append("--no-rerank")
    if not expand:
        cmd.append("--no-expand")
    cmd.append(query)

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        print(f"  [TIMEOUT] query={query[:60]!r}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  [ERROR] {e}", file=sys.stderr)
        return None

    if not proc.stdout.strip():
        return []

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"  [JSON ERROR] stdout={proc.stdout[:200]!r}", file=sys.stderr)
        return None

    return data.get("results", [])


def file_to_safe_docid(file_path: str) -> str:
    """Strip directory prefix and .md suffix to get the safe docid."""
    base = os.path.basename(file_path)
    if base.endswith(".md"):
        base = base[:-3]
    return base


def main() -> None:
    parser = argparse.ArgumentParser(description="Run seekx on MIRACL-zh benchmark queries.")
    parser.add_argument("--data-dir", default="bench/data", help="Data dir from prepare step (default: bench/data)")
    parser.add_argument("--top-k", type=int, default=10, help="Results per query (default: 10)")
    parser.add_argument("--collection", default="miracl-zh", help="seekx collection name (default: miracl-zh)")
    parser.add_argument("--rerank", action="store_true", help="Enable cross-encoder reranking (slower)")
    parser.add_argument("--expand", action="store_true", help="Enable LLM query expansion (requires expand API)")
    parser.add_argument("--seekx", default="seekx", help="Path/name of seekx binary (default: seekx)")
    parser.add_argument("--max-queries", type=int, default=0, help="Cap queries for a quick smoke test (0 = all)")
    parser.add_argument(
        "--min-score",
        type=float,
        default=0.0,
        help="Minimum vector similarity score before RRF fusion (default: 0, overrides config)",
    )
    args = parser.parse_args()

    data_dir = args.data_dir
    queries_path = os.path.join(data_dir, "queries.jsonl")
    docid_map_path = os.path.join(data_dir, "docid_map.json")
    out_path = os.path.join(data_dir, "results_seekx.jsonl")

    if not os.path.exists(queries_path):
        sys.exit(f"queries.jsonl not found at {queries_path}. Run prepare_miracl_zh.py first.")

    queries = load_jsonl(queries_path)
    if args.max_queries > 0:
        queries = queries[: args.max_queries]

    with open(docid_map_path, encoding="utf-8") as f:
        docid_map: dict[str, str] = json.load(f)

    mode_parts = []
    if args.rerank:
        mode_parts.append("rerank")
    if args.expand:
        mode_parts.append("expand")
    mode_label = "+".join(mode_parts) if mode_parts else "bm25+vec"
    print(f"seekx mode   : hybrid ({mode_label})")
    print(f"min-score    : {args.min_score}  (vector pre-RRF filter; 0 = no filtering)")
    print(f"top-k        : {args.top_k}")
    print(f"collection   : {args.collection}")
    print(f"queries      : {len(queries)}")
    print(f"output       : {out_path}")

    # Pre-flight: verify seekx status and API availability
    print("\n[pre-flight] Checking seekx status and API health…")
    try:
        status_proc = subprocess.run(
            [args.seekx, "status", "--json"],
            capture_output=True, text=True, timeout=15,
        )
        if status_proc.returncode == 0 and status_proc.stdout.strip():
            status = json.loads(status_proc.stdout)
            vec_ok = status.get("vectorSearchAvailable", False)
            print(f"  vector search available : {'✓' if vec_ok else '✗ (embedding not done or sqlite-vec missing)'}")
            if not vec_ok:
                print("  WARNING: Vector search unavailable — only BM25 will contribute to results.")
    except Exception as e:
        print(f"  WARNING: Could not run seekx status: {e}")

    if args.rerank or args.expand:
        try:
            health_proc = subprocess.run(
                [args.seekx, "config", "get", "provider.base_url"],
                capture_output=True, text=True, timeout=10,
            )
        except Exception:
            health_proc = None

        if args.rerank:
            rerank_model_proc = subprocess.run(
                [args.seekx, "config", "get", "provider.rerank_model"],
                capture_output=True, text=True, timeout=10,
            )
            rerank_model = rerank_model_proc.stdout.strip()
            if not rerank_model:
                print("  WARNING: --rerank enabled but no rerank model configured. Reranking will be skipped.")
            else:
                print(f"  rerank model : {rerank_model}")

        if args.expand:
            expand_model_proc = subprocess.run(
                [args.seekx, "config", "get", "provider.expand_model"],
                capture_output=True, text=True, timeout=10,
            )
            expand_model = expand_model_proc.stdout.strip()
            if not expand_model:
                print("  WARNING: --expand enabled but no expand model configured. Query expansion will be skipped.")
            else:
                print(f"  expand model : {expand_model}")

    print()

    out_f = open(out_path, "w", encoding="utf-8")
    ok = 0
    empty = 0
    errors = 0
    t0 = time.time()

    for i, q in enumerate(queries, 1):
        qid = q["query_id"]
        text = q["query"]
        hits_raw = run_seekx(
            text,
            seekx_bin=args.seekx,
            collection=args.collection,
            top_k=args.top_k,
            rerank=args.rerank,
            expand=args.expand,
            min_score=args.min_score,
        )

        if hits_raw is None:
            errors += 1
            hits = []
        elif len(hits_raw) == 0:
            empty += 1
            hits = []
        else:
            ok += 1
            hits = []
            for rank, h in enumerate(hits_raw, 1):
                safe = file_to_safe_docid(h.get("file", ""))
                original_docid = docid_map.get(safe, safe)
                hits.append(
                    {
                        "rank": rank,
                        "doc_id": original_docid,
                        "score": h.get("score", 0.0),
                        "file": h.get("file", ""),
                    }
                )

        record = {"query_id": qid, "query": text, "hits": hits}
        out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
        out_f.flush()

        elapsed = time.time() - t0
        avg_s = elapsed / i
        eta_s = avg_s * (len(queries) - i)
        print(
            f"  [{i:3d}/{len(queries)}] hits={len(hits):2d}  "
            f"avg={avg_s:.2f}s  ETA={eta_s:.0f}s  {text[:50]!r}",
            flush=True,
        )

    out_f.close()
    total = time.time() - t0
    print(f"\nDone in {total:.1f}s  (ok={ok}  empty={empty}  errors={errors})")
    print(f"Results → {out_path}")
    print("\nNext step:")
    print(f"  python3 bench/eval_ir.py --data-dir {data_dir}")


if __name__ == "__main__":
    main()
