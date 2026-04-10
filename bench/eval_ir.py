"""
eval_ir.py — Compute standard IR metrics for MIRACL-zh benchmark results.

Metrics (computed at cut-off K, default K=10):
  nDCG@K     Normalized Discounted Cumulative Gain — standard MIRACL metric.
  Recall@K   Fraction of relevant docs retrieved in top-K results.
  MRR@K      Mean Reciprocal Rank (rank of first relevant doc, capped at K).
  P@K        Precision at K.
  Hit@K      Binary: 1 if any relevant doc is in top K.

All metrics are macro-averaged over queries that have at least one relevant doc.
Queries without any qrel entry are skipped (reported separately).

Input files (from --data-dir):
  qrels.jsonl          {query_id, doc_id, relevance}
  results_*.jsonl      {query_id, query, hits: [{rank, doc_id, score}]}

Usage
-----
  # Evaluate seekx results only:
  python3 bench/eval_ir.py --data-dir bench/data

  # Compare multiple result files:
  python3 bench/eval_ir.py --data-dir bench/data \\
      --results bench/data/results_seekx.jsonl bench/data/results_qmd.jsonl \\
      --names seekx qmd
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def load_qrels(path: str) -> dict[str, dict[str, int]]:
    """Return {query_id: {doc_id: relevance_grade}}."""
    qrels: dict[str, dict[str, int]] = defaultdict(dict)
    for r in load_jsonl(path):
        qrels[r["query_id"]][r["doc_id"]] = int(r["relevance"])
    return dict(qrels)


def load_results(path: str) -> dict[str, list[str]]:
    """Return {query_id: [doc_id, ...]} ordered by rank (rank 1 first)."""
    runs: dict[str, list[str]] = {}
    for row in load_jsonl(path):
        qid = row["query_id"]
        hits = sorted(row.get("hits", []), key=lambda h: h.get("rank", 9999))
        runs[qid] = [h["doc_id"] for h in hits]
    return runs


# ---------------------------------------------------------------------------
# Metric computation
# ---------------------------------------------------------------------------

def dcg(rels: list[int], k: int) -> float:
    """Discounted Cumulative Gain at K (binary or graded relevance)."""
    return sum(
        (2 ** r - 1) / math.log2(i + 2)
        for i, r in enumerate(rels[:k])
    )


def ndcg_at_k(ranked_doc_ids: list[str], relevant: dict[str, int], k: int) -> float:
    rels = [relevant.get(d, 0) for d in ranked_doc_ids[:k]]
    ideal_rels = sorted(relevant.values(), reverse=True)
    idcg = dcg(ideal_rels, k)
    if idcg == 0:
        return 0.0
    return dcg(rels, k) / idcg


def recall_at_k(ranked_doc_ids: list[str], relevant: dict[str, int], k: int) -> float:
    n_relevant = sum(1 for v in relevant.values() if v > 0)
    if n_relevant == 0:
        return 0.0
    retrieved = sum(1 for d in ranked_doc_ids[:k] if relevant.get(d, 0) > 0)
    return retrieved / n_relevant


def mrr_at_k(ranked_doc_ids: list[str], relevant: dict[str, int], k: int) -> float:
    for i, d in enumerate(ranked_doc_ids[:k], 1):
        if relevant.get(d, 0) > 0:
            return 1.0 / i
    return 0.0


def precision_at_k(ranked_doc_ids: list[str], relevant: dict[str, int], k: int) -> float:
    hits = sum(1 for d in ranked_doc_ids[:k] if relevant.get(d, 0) > 0)
    return hits / min(k, len(ranked_doc_ids)) if ranked_doc_ids else 0.0


def hit_at_k(ranked_doc_ids: list[str], relevant: dict[str, int], k: int) -> float:
    return 1.0 if any(relevant.get(d, 0) > 0 for d in ranked_doc_ids[:k]) else 0.0


def evaluate(
    results: dict[str, list[str]],
    qrels: dict[str, dict[str, int]],
    k: int = 10,
) -> dict[str, float]:
    """Macro-average all metrics over queries that have at least one qrel entry."""
    metrics: dict[str, list[float]] = {
        "ndcg": [],
        "recall": [],
        "mrr": [],
        "precision": [],
        "hit": [],
    }
    skipped = 0

    for qid, relevant in qrels.items():
        if not any(v > 0 for v in relevant.values()):
            skipped += 1
            continue
        ranked = results.get(qid, [])
        metrics["ndcg"].append(ndcg_at_k(ranked, relevant, k))
        metrics["recall"].append(recall_at_k(ranked, relevant, k))
        metrics["mrr"].append(mrr_at_k(ranked, relevant, k))
        metrics["precision"].append(precision_at_k(ranked, relevant, k))
        metrics["hit"].append(hit_at_k(ranked, relevant, k))

    n = len(metrics["ndcg"])
    avg = {m: sum(v) / n if n > 0 else 0.0 for m, v in metrics.items()}
    avg["n_queries"] = float(n)
    avg["n_skipped"] = float(skipped)
    return avg


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_table(
    rows: list[tuple[str, dict[str, float]]],
    k: int,
) -> None:
    headers = [f"nDCG@{k}", f"Recall@{k}", f"MRR@{k}", f"P@{k}", f"Hit@{k}", "Queries"]
    col_w = max(len(h) for h in headers) + 2
    name_w = max(len(name) for name, _ in rows) + 2

    header_line = f"{'System':<{name_w}}" + "".join(f"{h:>{col_w}}" for h in headers)
    print(header_line)
    print("-" * len(header_line))

    for name, m in rows:
        vals = [
            f"{m['ndcg']:.4f}",
            f"{m['recall']:.4f}",
            f"{m['mrr']:.4f}",
            f"{m['precision']:.4f}",
            f"{m['hit']:.4f}",
            f"{int(m['n_queries'])}",
        ]
        print(f"{name:<{name_w}}" + "".join(f"{v:>{col_w}}" for v in vals))

    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate IR metrics for MIRACL-zh benchmark.")
    parser.add_argument("--data-dir", default="bench/data", help="Data directory (default: bench/data)")
    parser.add_argument(
        "--results",
        nargs="+",
        help="Path(s) to result JSONL files. Default: bench/data/results_seekx.jsonl",
    )
    parser.add_argument(
        "--names",
        nargs="+",
        help="System names corresponding to --results (default: filenames)",
    )
    parser.add_argument("--k", type=int, default=10, help="Cut-off for metrics (default: 10)")
    parser.add_argument("--json", dest="as_json", action="store_true", help="Output raw JSON instead of a table")
    args = parser.parse_args()

    qrels_path = os.path.join(args.data_dir, "qrels.jsonl")
    if not os.path.exists(qrels_path):
        sys.exit(f"qrels.jsonl not found at {qrels_path}. Run prepare_miracl_zh.py first.")

    qrels = load_qrels(qrels_path)

    # Default: look for results_seekx.jsonl in data-dir
    result_paths = args.results or [os.path.join(args.data_dir, "results_seekx.jsonl")]
    for p in result_paths:
        if not os.path.exists(p):
            sys.exit(f"Result file not found: {p}")

    names = args.names or [os.path.splitext(os.path.basename(p))[0] for p in result_paths]
    if len(names) != len(result_paths):
        sys.exit("--names count must match --results count.")

    rows: list[tuple[str, dict[str, float]]] = []
    all_metrics: dict[str, dict] = {}

    for path, name in zip(result_paths, names):
        results = load_results(path)
        m = evaluate(results, qrels, k=args.k)
        rows.append((name, m))
        all_metrics[name] = m

    if args.as_json:
        print(json.dumps({"k": args.k, "systems": all_metrics}, indent=2))
        return

    print(f"\n{'='*60}")
    print(f"  MIRACL-zh Benchmark  |  Metric cut-off K={args.k}")
    print(f"  Corpus: {len(qrels)} queries with qrels")
    print(f"{'='*60}\n")
    print_table(rows, args.k)

    # Print per-metric best system if comparing multiple
    if len(rows) > 1:
        for metric in [f"ndcg", f"recall", f"mrr"]:
            best_name = max(rows, key=lambda r: r[1][metric])[0]
            best_val = max(r[1][metric] for _, r in rows)
            print(f"  Best {metric.upper()}: {best_name} ({best_val:.4f})")
        print()


if __name__ == "__main__":
    main()
