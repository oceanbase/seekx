"""
eval_trec.py — Evaluate benchmark TREC run files.

The script prefers a local `trec_eval` binary when available and falls back to
an equivalent in-repo evaluator for `ndcg_cut` and `recall`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from miracl_benchmark import evaluate_trec_run, load_trec_qrels, load_trec_run
except ImportError:
    from bench.miracl_benchmark import evaluate_trec_run, load_trec_qrels, load_trec_run


def run_trec_eval(
    trec_eval_bin: str,
    qrels_path: Path,
    run_path: Path,
    ndcg_k: int,
    recall_k: int,
) -> dict[str, float]:
    cmd = [
        trec_eval_bin,
        "-c",
        "-m",
        f"ndcg_cut.{ndcg_k}",
        "-m",
        f"recall.{recall_k}",
        str(qrels_path),
        str(run_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"trec_eval exited with {proc.returncode}")

    metrics: dict[str, float] = {}
    for raw_line in proc.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        metric_name, scope, value = parts[:3]
        if scope != "all":
            continue
        metrics[metric_name] = float(value)
    return metrics


def print_table(rows: list[tuple[str, dict[str, float]]], ndcg_k: int, recall_k: int) -> None:
    headers = [f"nDCG@{ndcg_k}", f"Recall@{recall_k}"]
    name_w = max(len(name) for name, _ in rows) + 2
    col_w = max(len(header) for header in headers) + 2
    header_line = f"{'System':<{name_w}}" + "".join(f"{header:>{col_w}}" for header in headers)
    print(header_line)
    print("-" * len(header_line))
    for name, metrics in rows:
        values = [
            f"{metrics.get(f'ndcg_cut_{ndcg_k}', metrics.get(f'ndcg_cut.{ndcg_k}', 0.0)):.4f}",
            f"{metrics.get(f'recall_{recall_k}', metrics.get(f'recall.{recall_k}', 0.0)):.4f}",
        ]
        print(f"{name:<{name_w}}" + "".join(f"{value:>{col_w}}" for value in values))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate benchmark TREC run files.")
    parser.add_argument("--data-dir", default="bench/data", help="Benchmark data directory (default: bench/data)")
    parser.add_argument(
        "--qrels",
        default="",
        help="Path to TREC qrels (default: <data-dir>/qrels.dev.tsv)",
    )
    parser.add_argument(
        "--runs",
        nargs="+",
        help="One or more TREC run files (default: <data-dir>/results_seekx.trec)",
    )
    parser.add_argument(
        "--names",
        nargs="+",
        help="System names corresponding to --runs (default: run filenames)",
    )
    parser.add_argument("--ndcg-k", type=int, default=10, help="nDCG cut-off (default: 10)")
    parser.add_argument("--recall-k", type=int, default=100, help="Recall cut-off (default: 100)")
    parser.add_argument(
        "--trec-eval-bin",
        default="",
        help="Path to trec_eval binary (default: auto-detect from PATH)",
    )
    parser.add_argument("--json", dest="as_json", action="store_true", help="Print JSON instead of a table")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    qrels_path = Path(args.qrels) if args.qrels else data_dir / "qrels.dev.tsv"
    run_paths = [Path(run) for run in (args.runs or [str(data_dir / "results_seekx.trec")])]
    names = args.names or [run.stem for run in run_paths]

    if len(names) != len(run_paths):
        sys.exit("--names count must match --runs count.")
    if not qrels_path.exists():
        sys.exit(f"Qrels file not found: {qrels_path}")
    for run_path in run_paths:
        if not run_path.exists():
            sys.exit(f"Run file not found: {run_path}")

    trec_eval_bin = args.trec_eval_bin or shutil.which("trec_eval") or ""
    rows: list[tuple[str, dict[str, float]]] = []
    all_metrics: dict[str, dict[str, float | str]] = {}

    if trec_eval_bin:
        print(f"Using trec_eval: {trec_eval_bin}")
    else:
        print("trec_eval not found; using in-repo equivalent evaluator.")

    qrels = load_trec_qrels(qrels_path) if not trec_eval_bin else None

    for run_path, name in zip(run_paths, names):
        if trec_eval_bin:
            metrics = run_trec_eval(trec_eval_bin, qrels_path, run_path, args.ndcg_k, args.recall_k)
        else:
            if qrels is None:
                raise AssertionError("qrels should be loaded for the fallback evaluator")
            metrics = evaluate_trec_run(
                load_trec_run(run_path),
                qrels,
                ndcg_k=args.ndcg_k,
                recall_k=args.recall_k,
            )
        rows.append((name, metrics))
        all_metrics[name] = {
            "run_path": str(run_path),
            **metrics,
        }

    if args.as_json:
        print(
            json.dumps(
                {
                    "qrels": str(qrels_path),
                    "trec_eval_bin": trec_eval_bin or "",
                    "systems": all_metrics,
                },
                indent=2,
            )
        )
        return

    print(f"\nBenchmark evaluation")
    print(f"  qrels      : {qrels_path}")
    print(f"  nDCG cutoff: {args.ndcg_k}")
    print(f"  Recall cut : {args.recall_k}\n")
    print_table(rows, args.ndcg_k, args.recall_k)


if __name__ == "__main__":
    main()
