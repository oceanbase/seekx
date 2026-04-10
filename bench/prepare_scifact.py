"""
prepare_scifact.py — Prepare the SciFact BEIR benchmark assets.

This script downloads the official BEIR SciFact zip bundle and writes:
  - docs/            one plaintext file per document
  - queries.jsonl    normalized queries for run_seekx.py
  - qrels.jsonl      normalized qrels for local inspection
  - qrels.test.tsv   TREC-compatible qrels for evaluation
  - benchmark_manifest.json
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

try:
    from miracl_benchmark import Qrel, Topic, doc_path_for_docid, passage_to_plaintext
except ImportError:
    from bench.miracl_benchmark import Qrel, Topic, doc_path_for_docid, passage_to_plaintext


SCIFACT_BEIR_URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip"
SCIFACT_ZIP_NAME = "scifact.zip"
SCIFACT_ROOT = "scifact"
SCIFACT_QRELS_RELATIVE = "qrels/test.tsv"
SCIFACT_CORPUS_RELATIVE = "corpus.jsonl"
SCIFACT_QUERIES_RELATIVE = "queries.jsonl"


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def save_manifest(path: Path, manifest: dict) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)


def download_scifact(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = cache_dir / SCIFACT_ZIP_NAME
    if zip_path.exists():
        return zip_path
    print(f"Downloading SciFact bundle from {SCIFACT_BEIR_URL}…")
    try:
        with urllib.request.urlopen(SCIFACT_BEIR_URL, timeout=120) as response, zip_path.open("wb") as handle:
            shutil.copyfileobj(response, handle)
    except Exception as exc:
        sys.exit(f"Failed to download SciFact zip: {exc}")
    return zip_path


def extract_scifact(zip_path: Path, cache_dir: Path) -> Path:
    extracted_root = cache_dir / SCIFACT_ROOT
    if extracted_root.exists():
        return extracted_root
    print(f"Extracting {zip_path.name}…")
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(cache_dir)
    if not extracted_root.exists():
        sys.exit(f"Expected extracted SciFact directory at {extracted_root}, but it was not created.")
    return extracted_root


def read_queries(path: Path) -> list[Topic]:
    topics: list[Topic] = []
    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            row = json.loads(line)
            topics.append(Topic(query_id=str(row["_id"]), query=str(row["text"])))
    return topics


def read_qrels(path: Path) -> list[Qrel]:
    qrels: list[Qrel] = []
    with path.open(encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        header_skipped = False
        for row in reader:
            if not row:
                continue
            if not header_skipped and row[0] == "query-id":
                header_skipped = True
                continue
            if len(row) < 3:
                continue
            qrels.append(
                Qrel(
                    query_id=str(row[0]),
                    doc_id=str(row[1]),
                    relevance=int(row[2]),
                )
            )
    return qrels


def read_corpus(path: Path) -> list[dict]:
    corpus: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if line:
                corpus.append(json.loads(line))
    return corpus


def filter_topics(topics: list[Topic], qrels: list[Qrel], max_queries: int) -> list[Topic]:
    qids_with_labels = {qrel.query_id for qrel in qrels}
    filtered = [topic for topic in topics if topic.query_id in qids_with_labels]
    if max_queries > 0:
        filtered = filtered[:max_queries]
    return filtered


def filter_qrels(qrels: list[Qrel], topics: list[Topic]) -> list[Qrel]:
    selected = {topic.query_id for topic in topics}
    return [qrel for qrel in qrels if qrel.query_id in selected]


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


def write_qrels_tsv(path: Path, qrels: list[Qrel]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        handle.write("query-id\tcorpus-id\tscore\n")
        for qrel in qrels:
            handle.write(f"{qrel.query_id}\t{qrel.doc_id}\t{qrel.relevance}\n")


def materialize_docs(corpus: list[dict], docs_dir: Path, max_docs: int) -> dict[str, int]:
    docs_dir.mkdir(parents=True, exist_ok=True)
    processed = 0
    written = 0
    reused = 0
    for row in corpus:
        doc_id = str(row["_id"])
        target = docs_dir / doc_path_for_docid(doc_id)
        processed += 1
        if target.exists():
            reused += 1
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                passage_to_plaintext(str(row.get("title", "")), str(row.get("text", ""))),
                encoding="utf-8",
            )
            written += 1
        if max_docs > 0 and processed >= max_docs:
            break
    return {"processed": processed, "written": written, "reused": reused}


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare SciFact benchmark data.")
    parser.add_argument("--out-dir", default="bench/data-scifact", help="Output directory (default: bench/data-scifact)")
    parser.add_argument("--max-docs", type=int, default=0, help="Cap corpus docs for smoke tests (0 = full corpus)")
    parser.add_argument("--max-queries", type=int, default=0, help="Cap test queries for smoke tests (0 = all labeled queries)")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    docs_dir = out_dir / "docs"
    cache_dir = out_dir / ".cache"
    manifest_path = out_dir / "benchmark_manifest.json"
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest(manifest_path)

    print("Preparing SciFact benchmark assets…")
    print(f"  out dir     : {out_dir}")
    print(f"  max docs    : {args.max_docs or 'full corpus'}")
    print(f"  max queries : {args.max_queries or 'all labeled queries'}")
    print()

    zip_path = download_scifact(cache_dir)
    extracted_root = extract_scifact(zip_path, cache_dir)

    corpus_path = extracted_root / SCIFACT_CORPUS_RELATIVE
    queries_path = extracted_root / SCIFACT_QUERIES_RELATIVE
    qrels_path = extracted_root / SCIFACT_QRELS_RELATIVE

    topics = read_queries(queries_path)
    qrels = read_qrels(qrels_path)
    topics = filter_topics(topics, qrels, args.max_queries)
    qrels = filter_qrels(qrels, topics)
    corpus = read_corpus(corpus_path)
    corpus_stats = materialize_docs(corpus, docs_dir, args.max_docs)

    write_queries_jsonl(out_dir / "queries.jsonl", topics)
    write_qrels_jsonl(out_dir / "qrels.jsonl", qrels)
    write_qrels_tsv(out_dir / "qrels.test.tsv", qrels)

    manifest["scifact"] = {
        "source_url": SCIFACT_BEIR_URL,
        "zip_path": str(zip_path),
        "docs_dir": str(docs_dir),
        "queries": len(topics),
        "qrels": len(qrels),
        "corpus_processed": corpus_stats["processed"],
        "corpus_written": corpus_stats["written"],
        "corpus_reused": corpus_stats["reused"],
        "max_docs": args.max_docs,
        "max_queries": args.max_queries,
    }
    save_manifest(manifest_path, manifest)

    print(f"Queries   : {len(topics)}")
    print(f"Qrels     : {len(qrels)}")
    print(f"Docs      : {corpus_stats['processed']} processed ({corpus_stats['written']} written, {corpus_stats['reused']} reused)")
    print(f"Manifest  : {manifest_path}")
    print(f"Docs dir  : {docs_dir}")


if __name__ == "__main__":
    main()
