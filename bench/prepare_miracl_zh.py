"""
prepare_miracl_zh.py — Prepare the official MIRACL-zh benchmark assets.

This script downloads:
  1. MIRACL zh dev topics and qrels from `miracl/miracl`
  2. The full zh passage corpus from `miracl/miracl-corpus`

Outputs (written to --out-dir):
  queries.jsonl            Normalized queries for `run_seekx.py`
  qrels.jsonl              Normalized qrels for local inspection
  topics.dev.tsv           Official dev topics in TREC-compatible TSV form
  qrels.dev.tsv            Official dev qrels in TREC-compatible TSV form
  docs/                    One plaintext passage file per MIRACL docid
  benchmark_manifest.json  Versioned metadata for each completed stage

Each corpus passage is stored as a `.txt` file under a sharded path derived from
the MIRACL docid using a reversible base64-url encoding. This keeps filenames
portable while avoiding a massive sidecar `docid_map.json`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

try:
    from miracl_benchmark import (
        DOCID_CODEC,
        MIRACL_CORPUS_PREFIX,
        MIRACL_CORPUS_REPO,
        MIRACL_DATASET_REPO,
        MIRACL_LANG,
        MIRACL_QRELS_PATH,
        MIRACL_TOPICS_PATH,
        Qrel,
        Topic,
        doc_path_for_docid,
        iter_gzipped_jsonl,
        parse_qrels_tsv,
        parse_topics_tsv,
        passage_to_plaintext,
    )
except ImportError:
    from bench.miracl_benchmark import (
        DOCID_CODEC,
        MIRACL_CORPUS_PREFIX,
        MIRACL_CORPUS_REPO,
        MIRACL_DATASET_REPO,
        MIRACL_LANG,
        MIRACL_QRELS_PATH,
        MIRACL_TOPICS_PATH,
        Qrel,
        Topic,
        doc_path_for_docid,
        iter_gzipped_jsonl,
        parse_qrels_tsv,
        parse_topics_tsv,
        passage_to_plaintext,
    )


def natural_corpus_sort_key(path: str) -> tuple[int, str]:
    match = re.search(r"docs-(\d+)\.jsonl\.gz$", path)
    if match:
        return int(match.group(1)), path
    return sys.maxsize, path


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def save_manifest(path: Path, manifest: dict) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)


def ensure_hf_client():
    try:
        from huggingface_hub import HfApi, hf_hub_download  # type: ignore[import]
    except ImportError:
        sys.exit("huggingface_hub not found. Run: pip install huggingface_hub")
    return HfApi, hf_hub_download


def write_queries_jsonl(path: Path, topics: list[Topic]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for topic in topics:
            handle.write(
                json.dumps(
                    {"query_id": topic.query_id, "query": topic.query},
                    ensure_ascii=False,
                )
                + "\n"
            )


def write_qrels_jsonl(path: Path, qrels: list[Qrel]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for qrel in qrels:
            handle.write(
                json.dumps(
                    {
                        "query_id": qrel.query_id,
                        "doc_id": qrel.doc_id,
                        "relevance": qrel.relevance,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )


def prepare_topics_qrels(
    out_dir: Path,
    cache_dir: Path,
    manifest: dict,
) -> dict:
    _, hf_hub_download = ensure_hf_client()

    topics_local = Path(
        hf_hub_download(
            repo_id=MIRACL_DATASET_REPO,
            filename=MIRACL_TOPICS_PATH,
            repo_type="dataset",
            cache_dir=str(cache_dir),
        )
    )
    qrels_local = Path(
        hf_hub_download(
            repo_id=MIRACL_DATASET_REPO,
            filename=MIRACL_QRELS_PATH,
            repo_type="dataset",
            cache_dir=str(cache_dir),
        )
    )

    topics_text = topics_local.read_text(encoding="utf-8")
    qrels_text = qrels_local.read_text(encoding="utf-8")
    topics = parse_topics_tsv(topics_text)
    qrels = parse_qrels_tsv(qrels_text)

    (out_dir / "topics.dev.tsv").write_text(topics_text, encoding="utf-8")
    (out_dir / "qrels.dev.tsv").write_text(qrels_text, encoding="utf-8")
    write_queries_jsonl(out_dir / "queries.jsonl", topics)
    write_qrels_jsonl(out_dir / "qrels.jsonl", qrels)

    stats = {
        "repo": MIRACL_DATASET_REPO,
        "lang": MIRACL_LANG,
        "topics_path": MIRACL_TOPICS_PATH,
        "qrels_path": MIRACL_QRELS_PATH,
        "queries": len(topics),
        "qrels": len(qrels),
    }
    manifest["topics_qrels"] = stats
    return stats


def prepare_corpus(
    docs_dir: Path,
    cache_dir: Path,
    manifest: dict,
    max_docs: int,
) -> dict:
    HfApi, hf_hub_download = ensure_hf_client()
    api = HfApi()

    try:
        all_files = api.list_repo_files(MIRACL_CORPUS_REPO, repo_type="dataset")
    except Exception as exc:
        sys.exit(
            f"Cannot list files in {MIRACL_CORPUS_REPO}: {exc}\n"
            "Set HF_ENDPOINT=https://hf-mirror.com if you are behind a firewall."
        )

    corpus_files = sorted(
        (
            file_path
            for file_path in all_files
            if file_path.startswith(MIRACL_CORPUS_PREFIX) and file_path.endswith(".jsonl.gz")
        ),
        key=natural_corpus_sort_key,
    )
    if not corpus_files:
        sys.exit(f"No zh corpus files found under prefix {MIRACL_CORPUS_PREFIX!r} in {MIRACL_CORPUS_REPO}.")

    docs_dir.mkdir(parents=True, exist_ok=True)
    processed = 0
    written = 0
    skipped_existing = 0

    for idx, filename in enumerate(corpus_files, start=1):
        print(f"[corpus] [{idx}/{len(corpus_files)}] Downloading {filename}…", flush=True)
        local = Path(
            hf_hub_download(
                repo_id=MIRACL_CORPUS_REPO,
                filename=filename,
                repo_type="dataset",
                cache_dir=str(cache_dir),
            )
        )
        for row in iter_gzipped_jsonl(local):
            docid = str(row["docid"])
            target = docs_dir / doc_path_for_docid(docid)
            processed += 1
            if target.exists():
                skipped_existing += 1
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(
                    passage_to_plaintext(
                        str(row.get("title", "")),
                        str(row.get("text", "")),
                    ),
                    encoding="utf-8",
                )
                written += 1
            if processed % 10000 == 0:
                print(
                    f"  processed={processed:,} written={written:,} skipped_existing={skipped_existing:,}",
                    flush=True,
                )
            if max_docs > 0 and processed >= max_docs:
                break
        if max_docs > 0 and processed >= max_docs:
            break

    stats = {
        "repo": MIRACL_CORPUS_REPO,
        "lang": MIRACL_LANG,
        "corpus_prefix": MIRACL_CORPUS_PREFIX,
        "files_seen": len(corpus_files),
        "passages_processed": processed,
        "passages_written": written,
        "passages_reused": skipped_existing,
        "docid_codec": DOCID_CODEC,
        "docs_dir": str(docs_dir),
        "max_docs": max_docs,
    }
    manifest["corpus"] = stats
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare official MIRACL-zh benchmark data.")
    parser.add_argument("--out-dir", default="bench/data", help="Output directory (default: bench/data)")
    parser.add_argument(
        "--stage",
        choices=["all", "topics-qrels", "corpus"],
        default="all",
        help="Which stage to run (default: all)",
    )
    parser.add_argument(
        "--max-docs",
        type=int,
        default=0,
        help="Cap corpus passages for a smoke test (0 = full corpus, default)",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    docs_dir = out_dir / "docs"
    cache_dir = out_dir / ".hf_cache"
    manifest_path = out_dir / "benchmark_manifest.json"
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest(manifest_path)

    hf_endpoint = os.getenv("HF_ENDPOINT")
    print("Preparing official MIRACL-zh benchmark assets…")
    print(f"  out dir     : {out_dir}")
    print(f"  stage       : {args.stage}")
    print(f"  HF_ENDPOINT : {hf_endpoint or '(default huggingface.co)'}")
    print(f"  max docs    : {args.max_docs or 'full corpus'}")
    print(f"  docid codec : {DOCID_CODEC}")
    print()

    if args.stage in {"all", "topics-qrels"}:
        print("[stage] Downloading dev topics and qrels…")
        topics_stats = prepare_topics_qrels(out_dir, cache_dir, manifest)
        print(
            f"  queries={topics_stats['queries']} qrels={topics_stats['qrels']} "
            f"→ {out_dir / 'queries.jsonl'}"
        )
        save_manifest(manifest_path, manifest)
        print()

    if args.stage in {"all", "corpus"}:
        print("[stage] Downloading and materializing zh corpus passages…")
        corpus_stats = prepare_corpus(docs_dir, cache_dir, manifest, args.max_docs)
        print(
            f"  processed={corpus_stats['passages_processed']:,} "
            f"written={corpus_stats['passages_written']:,} "
            f"reused={corpus_stats['passages_reused']:,}"
        )
        save_manifest(manifest_path, manifest)
        print()

    print("Done.")
    print(f"Manifest → {manifest_path}")
    if args.stage != "topics-qrels":
        print(f"Docs     → {docs_dir}")


if __name__ == "__main__":
    main()
