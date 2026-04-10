"""
run_seekx.py — Run seekx over benchmark queries and emit a TREC run file.

The seekx CLI returns chunk-level results. This script collapses those hits back
to document-level docids before ranking and evaluation.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

try:
    from miracl_benchmark import aggregate_hits_by_docid, format_trec_run_line, load_queries_jsonl
except ImportError:
    from bench.miracl_benchmark import aggregate_hits_by_docid, format_trec_run_line, load_queries_jsonl


def load_seekx_results(stdout: str) -> list[dict] | None:
    if not stdout.strip():
        return []
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    return payload.get("results", [])


def run_seekx(
    query: str,
    *,
    seekx_bin: str,
    collection: str,
    limit: int,
    rerank: bool,
    expand: bool,
    min_score: float = 0.0,
) -> list[dict] | None:
    cmd = [seekx_bin, "search", "--json", "-n", str(limit), "-c", collection, "--min-score", str(min_score)]
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
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        print(f"  [TIMEOUT] query={query[:80]!r}", file=sys.stderr)
        return None
    except Exception as exc:
        print(f"  [ERROR] {exc}", file=sys.stderr)
        return None

    results = load_seekx_results(proc.stdout)
    if results is None:
        print(f"  [JSON ERROR] stdout={proc.stdout[:200]!r}", file=sys.stderr)
    return results


def preflight(args: argparse.Namespace) -> None:
    print("\n[pre-flight] Checking seekx status and API health…")
    try:
        status_proc = subprocess.run(
            [args.seekx, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if status_proc.returncode == 0 and status_proc.stdout.strip():
            status = json.loads(status_proc.stdout)
            vec_ok = status.get("vectorSearchAvailable", False)
            print(f"  vector search available : {'yes' if vec_ok else 'no'}")
            if not vec_ok:
                print("  WARNING: Vector search unavailable. Hybrid benchmark numbers may not be representative.")
    except Exception as exc:
        print(f"  WARNING: Could not run seekx status: {exc}")

    if args.rerank:
        rerank_proc = subprocess.run(
            [args.seekx, "config", "get", "provider.rerank_model"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        rerank_model = rerank_proc.stdout.strip()
        print(f"  rerank model            : {rerank_model or '(not configured)'}")

    if args.expand:
        expand_proc = subprocess.run(
            [args.seekx, "config", "get", "provider.expand_model"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        expand_model = expand_proc.stdout.strip()
        print(f"  expand model            : {expand_model or '(not configured)'}")
    print()


def default_run_name(args: argparse.Namespace) -> str:
    parts = ["seekx-hybrid"]
    if args.rerank:
        parts.append("rerank")
    if args.expand:
        parts.append("expand")
    return "+".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run seekx on benchmark queries and emit a TREC run.")
    parser.add_argument("--data-dir", default="bench/data", help="Data dir from prepare step (default: bench/data)")
    parser.add_argument("--collection", default="miracl-zh", help="seekx collection name (default: miracl-zh)")
    parser.add_argument("--rerank", action="store_true", help="Enable cross-encoder reranking")
    parser.add_argument("--expand", action="store_true", help="Enable LLM query expansion")
    parser.add_argument("--seekx", default="seekx", help="Path/name of seekx binary (default: seekx)")
    parser.add_argument("--max-queries", type=int, default=0, help="Cap queries for a smoke test (0 = all)")
    parser.add_argument(
        "--run-depth",
        "--top-k",
        dest="run_depth",
        type=int,
        default=1000,
        help="Number of doc-level results to keep in the TREC run (default: 1000)",
    )
    parser.add_argument(
        "--search-limit",
        type=int,
        default=0,
        help="Raw chunk-level limit passed to `seekx search` (default: max(run_depth*4, 200))",
    )
    parser.add_argument(
        "--min-score",
        type=float,
        default=0.0,
        help="Minimum vector similarity score before RRF fusion (default: 0)",
    )
    parser.add_argument(
        "--run-name",
        default="",
        help="System name written to the TREC run file (default: derived from flags)",
    )
    parser.add_argument(
        "--jsonl-out",
        default="",
        help="Output path for aggregated JSONL results (default: <data-dir>/results_seekx.jsonl)",
    )
    parser.add_argument(
        "--trec-out",
        default="",
        help="Output path for TREC run (default: <data-dir>/results_seekx.trec)",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    queries_path = data_dir / "queries.jsonl"
    jsonl_out = Path(args.jsonl_out) if args.jsonl_out else data_dir / "results_seekx.jsonl"
    trec_out = Path(args.trec_out) if args.trec_out else data_dir / "results_seekx.trec"
    run_name = args.run_name or default_run_name(args)
    search_limit = args.search_limit or max(args.run_depth * 4, 200)

    if not queries_path.exists():
        sys.exit(f"queries.jsonl not found at {queries_path}. Run the dataset prepare step first.")
    if args.run_depth < 1:
        sys.exit("--run-depth must be a positive integer.")
    if search_limit < args.run_depth:
        sys.exit("--search-limit must be >= --run-depth so doc aggregation has enough candidates.")

    queries = load_queries_jsonl(queries_path)
    if args.max_queries > 0:
        queries = queries[: args.max_queries]

    print("seekx benchmark run")
    print(f"  data dir     : {data_dir}")
    print(f"  collection   : {args.collection}")
    print(f"  queries      : {len(queries)}")
    print(f"  run depth    : {args.run_depth}")
    print(f"  search limit : {search_limit}")
    print(f"  run name     : {run_name}")
    print(f"  rerank       : {args.rerank}")
    print(f"  expand       : {args.expand}")
    print(f"  min score    : {args.min_score}")
    print(f"  jsonl out    : {jsonl_out}")
    print(f"  trec out     : {trec_out}")

    preflight(args)

    jsonl_out.parent.mkdir(parents=True, exist_ok=True)
    trec_out.parent.mkdir(parents=True, exist_ok=True)

    ok = 0
    empty = 0
    errors = 0
    t0 = time.time()

    with jsonl_out.open("w", encoding="utf-8") as jsonl_handle, trec_out.open("w", encoding="utf-8") as trec_handle:
        for idx, query in enumerate(queries, start=1):
            query_id = str(query["query_id"])
            text = str(query["query"])
            raw_hits = run_seekx(
                text,
                seekx_bin=args.seekx,
                collection=args.collection,
                limit=search_limit,
                rerank=args.rerank,
                expand=args.expand,
                min_score=args.min_score,
            )

            if raw_hits is None:
                errors += 1
                doc_hits: list[dict] = []
            elif not raw_hits:
                empty += 1
                doc_hits = []
            else:
                ok += 1
                doc_hits = aggregate_hits_by_docid(raw_hits, args.run_depth)

            record = {
                "query_id": query_id,
                "query": text,
                "run_name": run_name,
                "raw_hit_count": 0 if raw_hits is None else len(raw_hits),
                "hits": doc_hits,
            }
            jsonl_handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            jsonl_handle.flush()

            for hit in doc_hits:
                trec_handle.write(
                    format_trec_run_line(
                        query_id=query_id,
                        doc_id=str(hit["doc_id"]),
                        rank=int(hit["rank"]),
                        score=float(hit["score"]),
                        system_name=run_name,
                    )
                    + "\n"
                )
            trec_handle.flush()

            elapsed = time.time() - t0
            avg_s = elapsed / idx
            eta_s = avg_s * (len(queries) - idx)
            print(
                f"  [{idx:3d}/{len(queries)}] raw={0 if raw_hits is None else len(raw_hits):4d} "
                f"docs={len(doc_hits):4d} avg={avg_s:.2f}s ETA={eta_s:.0f}s {text[:50]!r}",
                flush=True,
            )

    total = time.time() - t0
    print(f"\nDone in {total:.1f}s (ok={ok} empty={empty} errors={errors})")
    print(f"Aggregated JSONL → {jsonl_out}")
    print(f"TREC run        → {trec_out}")


if __name__ == "__main__":
    main()
