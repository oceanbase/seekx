"""
prepare_miracl_zh.py — Download MIRACL Chinese data and build the benchmark corpus.

Data source: miracl/miracl (HuggingFace), Chinese subset.
  - Dev queries: 393 queries, each with positive_passages and negative_passages.
  - Train queries: 1,312 queries, used as distractor passages only.

Corpus strategy
---------------
We build the corpus entirely from passages embedded in the dataset objects,
avoiding the need to stream the 4.9 M-passage zh corpus:

  1. Collect all passages (positive + negative) from the dev split.
  2. Collect all passages (positive + negative) from the train split.
  3. Union by docid, capped at --max-corpus passages.

Each passage becomes a single Markdown file:
  docs/{safe_docid}.md
    # {title}

    {text}

The file name uses a sanitized docid (# → _) so it works on all filesystems.
A sidecar JSON maps safe_docid → original docid for evaluation.

Outputs (written to --out-dir, default: bench/data/):
  docs/               Markdown files, one per passage
  queries.jsonl       {query_id, query} per line
  qrels.jsonl         {query_id, doc_id, relevance} per line (binary, grade=1)
  docid_map.json      {safe_docid: original_docid}
  stats.json          Summary counts

Implementation note
-------------------
`miracl/miracl` uses a custom loading script (miracl.py) which is no longer
supported in `datasets >= 4.x`.  We bypass it entirely by downloading the raw
JSONL files directly via the HuggingFace Hub file API (`huggingface_hub`), which
is a standard dependency of `datasets` and always available.

Set HF_ENDPOINT=https://hf-mirror.com if HuggingFace is unreachable.

Usage
-----
  python3 bench/prepare_miracl_zh.py [--out-dir bench/data] [--max-queries N] [--max-corpus N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import warnings

warnings.filterwarnings("ignore")


def safe_docid(docid: str) -> str:
    """Replace characters not safe for filenames."""
    return re.sub(r"[#/\\:*?\"<>|]", "_", docid)


def passage_to_markdown(title: str, text: str) -> str:
    title = title.strip() if title else ""
    text = text.strip() if text else ""
    if title:
        return f"# {title}\n\n{text}\n"
    return f"{text}\n"


def collect_passages(dataset_split) -> dict[str, dict]:
    """Return {docid: {title, text}} for all passages in a HuggingFace MIRACL split."""
    passages: dict[str, dict] = {}
    for row in dataset_split:
        for p in row.get("positive_passages") or []:
            docid = p["docid"]
            if docid not in passages:
                passages[docid] = {"title": p.get("title", ""), "text": p["text"]}
        for p in row.get("negative_passages") or []:
            docid = p["docid"]
            if docid not in passages:
                passages[docid] = {"title": p.get("title", ""), "text": p["text"]}
    return passages


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare MIRACL-zh benchmark data.")
    parser.add_argument("--out-dir", default="bench/data", help="Output directory (default: bench/data)")
    parser.add_argument(
        "--max-queries",
        type=int,
        default=0,
        help="Cap on dev queries to use (0 = all, default)",
    )
    parser.add_argument(
        "--max-corpus",
        type=int,
        default=0,
        help="Cap on corpus passages (0 = all collected, default)",
    )
    args = parser.parse_args()

    out_dir = args.out_dir
    docs_dir = os.path.join(out_dir, "docs")
    os.makedirs(docs_dir, exist_ok=True)

    print("Loading MIRACL-zh dataset from HuggingFace Hub (raw JSONL files)…")
    print("This may take a minute on first run as files are cached locally.\n")

    try:
        from huggingface_hub import HfApi, hf_hub_download  # type: ignore[import]
    except ImportError:
        sys.exit("huggingface_hub not found. Run: pip install huggingface_hub")

    hf_cache = os.path.join(out_dir, ".hf_cache")

    def load_miracl_split(split: str) -> list[dict]:
        """
        Download MIRACL zh JSONL files directly via HuggingFace Hub API,
        bypassing the loading script (not supported in datasets >= 4.x).

        Each line is:
          {"query_id": ..., "query": ...,
           "positive_passages": [{docid, title, text}, ...],
           "negative_passages": [{docid, title, text}, ...]}
        """
        api = HfApi()
        try:
            all_files = list(api.list_repo_files("miracl/miracl", repo_type="dataset"))
        except Exception as e:
            sys.exit(f"Cannot list files in miracl/miracl on HuggingFace Hub: {e}\n"
                     "Set HF_ENDPOINT=https://hf-mirror.com if you are behind a firewall.")

        # Match files like "miracl-v1.0/zh/dev/miracl-v1.0-zh-dev.jsonl"
        target = [f for f in all_files if f"/zh/{split}/" in f and f.endswith(".jsonl")]
        if not target:
            sys.exit(f"No JSONL files found for split={split!r} under miracl/miracl (zh).\n"
                     f"Available files: {[f for f in all_files if 'zh' in f][:10]}")

        records: list[dict] = []
        for filename in target:
            print(f"  Downloading {filename}…")
            local = hf_hub_download(
                repo_id="miracl/miracl",
                filename=filename,
                repo_type="dataset",
                cache_dir=hf_cache,
            )
            with open(local, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        records.append(json.loads(line))
        return records

    ds_dev = load_miracl_split("dev")
    ds_train = load_miracl_split("train")

    # -- Queries & qrels from dev split --
    queries: list[dict] = []
    qrels: list[dict] = []

    for row in ds_dev:
        qid = row["query_id"]
        queries.append({"query_id": qid, "query": row["query"]})
        for p in row.get("positive_passages") or []:
            qrels.append({"query_id": qid, "doc_id": p["docid"], "relevance": 1})

    if args.max_queries > 0:
        queries = queries[: args.max_queries]
        kept_qids = {q["query_id"] for q in queries}
        qrels = [r for r in qrels if r["query_id"] in kept_qids]

    print(f"Dev queries  : {len(queries)}")
    print(f"Dev qrels    : {len(qrels)} (relevant pairs)")

    # -- Corpus: dev passages + train passages as distractors --
    print("\nCollecting corpus passages from dev + train splits…")
    corpus_dev = collect_passages(ds_dev)
    corpus_train = collect_passages(ds_train)

    # Merge; dev passages take precedence (they're the ones we evaluate on).
    all_passages: dict[str, dict] = {**corpus_train, **corpus_dev}

    if args.max_corpus > 0:
        # Keep all dev-referenced passages, then pad with train passages.
        dev_docids = {r["doc_id"] for r in qrels}
        mandatory = {d: v for d, v in all_passages.items() if d in dev_docids}
        extras = {
            d: v
            for d, v in all_passages.items()
            if d not in dev_docids
        }
        budget = max(0, args.max_corpus - len(mandatory))
        extras_trimmed = dict(list(extras.items())[:budget])
        all_passages = {**mandatory, **extras_trimmed}

    print(f"Corpus size  : {len(all_passages)} unique passages\n")

    # -- Write docs --
    docid_map: dict[str, str] = {}  # safe_docid → original docid
    written = 0
    for docid, psg in all_passages.items():
        sid = safe_docid(docid)
        docid_map[sid] = docid
        md = passage_to_markdown(psg["title"], psg["text"])
        path = os.path.join(docs_dir, f"{sid}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(md)
        written += 1

    print(f"Written {written} .md files → {docs_dir}/")

    # -- Write queries.jsonl --
    qpath = os.path.join(out_dir, "queries.jsonl")
    with open(qpath, "w", encoding="utf-8") as f:
        for q in queries:
            f.write(json.dumps(q, ensure_ascii=False) + "\n")
    print(f"Written {len(queries)} queries → {qpath}")

    # -- Write qrels.jsonl --
    rpath = os.path.join(out_dir, "qrels.jsonl")
    with open(rpath, "w", encoding="utf-8") as f:
        for r in qrels:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"Written {len(qrels)} qrel pairs → {rpath}")

    # -- Write docid_map.json --
    mpath = os.path.join(out_dir, "docid_map.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(docid_map, f, ensure_ascii=False, indent=2)
    print(f"Written docid map ({len(docid_map)} entries) → {mpath}")

    # -- Write stats.json --
    stats = {
        "queries": len(queries),
        "qrels": len(qrels),
        "corpus": len(all_passages),
    }
    spath = os.path.join(out_dir, "stats.json")
    with open(spath, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)

    print(f"\nDone. Benchmark data ready in: {out_dir}/")
    print("\nNext step:")
    print(f"  seekx add {docs_dir} --name miracl-zh")
    print("  python3 bench/run_seekx.py")


if __name__ == "__main__":
    main()
