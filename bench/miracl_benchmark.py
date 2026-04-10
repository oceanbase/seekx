"""
Shared helpers for the official MIRACL benchmark scripts.
"""

from __future__ import annotations

import base64
import gzip
import json
import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator


MIRACL_DATASET_REPO = "miracl/miracl"
MIRACL_CORPUS_REPO = "miracl/miracl-corpus"
MIRACL_LANG = "zh"
MIRACL_TOPICS_PATH = f"miracl-v1.0-{MIRACL_LANG}/topics/topics.miracl-v1.0-{MIRACL_LANG}-dev.tsv"
MIRACL_QRELS_PATH = f"miracl-v1.0-{MIRACL_LANG}/qrels/qrels.miracl-v1.0-{MIRACL_LANG}-dev.tsv"
MIRACL_CORPUS_PREFIX = f"miracl-corpus-v1.0-{MIRACL_LANG}/"
DOCID_CODEC = "base64-url-nopad"


@dataclass(frozen=True)
class Topic:
    query_id: str
    query: str


@dataclass(frozen=True)
class Qrel:
    query_id: str
    doc_id: str
    relevance: int


def encode_docid(docid: str) -> str:
    """Encode a MIRACL docid into a filesystem-safe reversible string."""
    raw = docid.encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_docid(encoded: str) -> str:
    """Decode a filesystem-safe MIRACL docid back to the original string."""
    padding = "=" * (-len(encoded) % 4)
    return base64.urlsafe_b64decode((encoded + padding).encode("ascii")).decode("utf-8")


def doc_path_for_docid(docid: str, extension: str = ".txt") -> Path:
    encoded = encode_docid(docid)
    shard = encoded[:2] if len(encoded) >= 2 else "00"
    return Path(shard) / f"{encoded}{extension}"


def docid_from_path(file_path: str) -> str:
    encoded = Path(file_path).stem
    return decode_docid(encoded)


def passage_to_plaintext(title: str, text: str) -> str:
    title = title.strip()
    text = text.strip()
    if title and text:
        return f"{title}\n\n{text}\n"
    if title:
        return f"{title}\n"
    return f"{text}\n"


def parse_topics_tsv(text: str) -> list[Topic]:
    topics: list[Topic] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        query_id, query = line.split("\t", 1)
        topics.append(Topic(query_id=query_id, query=query))
    return topics


def parse_qrels_tsv(text: str) -> list[Qrel]:
    qrels: list[Qrel] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        query_id, _iter_tag, doc_id, relevance = line.split()
        qrels.append(Qrel(query_id=query_id, doc_id=doc_id, relevance=int(relevance)))
    return qrels


def iter_gzipped_jsonl(path: Path) -> Iterator[dict]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if line:
                yield json.loads(line)


def load_queries_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_qrels_jsonl(path: Path) -> dict[str, dict[str, int]]:
    qrels: dict[str, dict[str, int]] = defaultdict(dict)
    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            row = json.loads(line)
            qrels[str(row["query_id"])][str(row["doc_id"])] = int(row["relevance"])
    return dict(qrels)


def load_trec_qrels(path: Path) -> dict[str, dict[str, int]]:
    qrels: dict[str, dict[str, int]] = defaultdict(dict)
    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            parts = line.split()
            if parts[0] == "query-id":
                continue
            if len(parts) == 4:
                query_id, _iter_tag, doc_id, relevance = parts
            elif len(parts) == 3:
                query_id, doc_id, relevance = parts
            else:
                raise ValueError(f"Unsupported qrels line format: {line!r}")
            qrels[query_id][doc_id] = int(relevance)
    return dict(qrels)


def load_trec_run(path: Path) -> dict[str, list[dict]]:
    runs: dict[str, list[dict]] = defaultdict(list)
    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            query_id, _iter_tag, doc_id, rank, score, system = line.split(maxsplit=5)
            runs[query_id].append(
                {
                    "doc_id": doc_id,
                    "rank": int(rank),
                    "score": float(score),
                    "system": system,
                }
            )
    for query_id in runs:
        runs[query_id].sort(key=lambda row: (row["rank"], -row["score"], row["doc_id"]))
    return dict(runs)


def aggregate_hits_by_docid(hits: list[dict], limit: int) -> list[dict]:
    """
    Collapse chunk-level hits into doc-level rankings.

    The highest score for a document becomes its document score. The best-ranked
    chunk is kept as representative metadata.
    """
    docs: dict[str, dict] = {}
    for chunk_rank, hit in enumerate(hits, start=1):
        doc_id = docid_from_path(hit.get("file", ""))
        score = float(hit.get("score", 0.0))
        entry = docs.get(doc_id)
        payload = {
            "doc_id": doc_id,
            "score": score,
            "file": hit.get("file", ""),
            "chunk_id": hit.get("chunk_id"),
            "chunk_rank": chunk_rank,
        }
        if entry is None:
            docs[doc_id] = payload
            continue
        if score > float(entry["score"]):
            entry["score"] = score
            entry["file"] = payload["file"]
            entry["chunk_id"] = payload["chunk_id"]
        entry["chunk_rank"] = min(int(entry["chunk_rank"]), chunk_rank)

    ranked = sorted(
        docs.values(),
        key=lambda row: (-float(row["score"]), int(row["chunk_rank"]), str(row["doc_id"])),
    )
    trimmed = ranked[:limit]
    return [
        {
            "rank": rank,
            "doc_id": row["doc_id"],
            "score": float(row["score"]),
            "file": row["file"],
            "chunk_id": row["chunk_id"],
            "chunk_rank": row["chunk_rank"],
        }
        for rank, row in enumerate(trimmed, start=1)
    ]


def format_trec_run_line(
    query_id: str,
    doc_id: str,
    rank: int,
    score: float,
    system_name: str,
) -> str:
    return f"{query_id} Q0 {doc_id} {rank} {score:.10f} {system_name}"


def dcg(relevances: Iterable[int], k: int) -> float:
    total = 0.0
    for idx, rel in enumerate(list(relevances)[:k]):
        total += (2**rel - 1) / math.log2(idx + 2)
    return total


def ndcg_at_k(ranked_doc_ids: list[str], relevant: dict[str, int], k: int) -> float:
    gains = [relevant.get(doc_id, 0) for doc_id in ranked_doc_ids[:k]]
    ideal = sorted(relevant.values(), reverse=True)
    ideal_dcg = dcg(ideal, k)
    if ideal_dcg == 0:
        return 0.0
    return dcg(gains, k) / ideal_dcg


def recall_at_k(ranked_doc_ids: list[str], relevant: dict[str, int], k: int) -> float:
    positive = {doc_id for doc_id, rel in relevant.items() if rel > 0}
    if not positive:
        return 0.0
    hits = sum(1 for doc_id in ranked_doc_ids[:k] if doc_id in positive)
    return hits / len(positive)


def evaluate_trec_run(
    run: dict[str, list[dict]],
    qrels: dict[str, dict[str, int]],
    ndcg_k: int = 10,
    recall_k: int = 100,
) -> dict[str, float]:
    ndcgs: list[float] = []
    recalls: list[float] = []

    for query_id, relevant in qrels.items():
        ranked_doc_ids = [row["doc_id"] for row in run.get(query_id, [])]
        ndcgs.append(ndcg_at_k(ranked_doc_ids, relevant, ndcg_k))
        recalls.append(recall_at_k(ranked_doc_ids, relevant, recall_k))

    count = len(qrels)
    return {
        f"ndcg_cut_{ndcg_k}": sum(ndcgs) / count if count else 0.0,
        f"recall_{recall_k}": sum(recalls) / count if count else 0.0,
        "num_queries": float(count),
    }
