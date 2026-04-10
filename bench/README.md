# Benchmark Usage Guide

This directory contains two benchmark workflows:

- `bench/run_scifact.sh`: a small, low-cost benchmark based on **SciFact**
- `bench/run_all.sh`: a larger, official-style benchmark for **MIRACL-zh**

If you are debugging the pipeline, comparing systems quickly, or trying to keep
 costs low, start with **SciFact**. If you need a Chinese benchmark with
 official-style MIRACL-zh evaluation, use the MIRACL workflow.

## Benchmark Layout

Shared scripts:

- `bench/run_seekx.py`: runs `seekx search`, aggregates chunk-level hits back to
  document-level docids, and writes both JSONL and TREC run files
- `bench/eval_trec.py`: evaluates TREC run files with `trec_eval` when
  available, or with the in-repo fallback evaluator otherwise
- `bench/miracl_benchmark.py`: shared helpers for docid encoding, qrels parsing,
  TREC run formatting, and fallback evaluation

Dataset-specific scripts:

- `bench/prepare_scifact.py`: downloads and prepares SciFact
- `bench/prepare_miracl_zh.py`: downloads and prepares MIRACL-zh
- `bench/run_scifact.sh`: SciFact end-to-end driver
- `bench/run_all.sh`: MIRACL-zh end-to-end driver

## Prerequisites

Required:

- `seekx` installed and available in `PATH`
- Python 3.11+

Recommended:

- `trec_eval` installed for official metric computation

Check your environment:

```bash
seekx --version
python3 --version
command -v trec_eval || true
```

Install `trec_eval` on macOS:

```bash
brew install trec_eval
```

## Important Concepts

### Data Directory

Each benchmark writes all generated artifacts into `DATA_DIR`:

- prepared corpus under `docs/`
- normalized queries and qrels
- TREC run files
- benchmark manifest

Use a **fresh** `DATA_DIR` for each benchmark family or experiment variant.

### Collection Name

`seekx` stores benchmark indexes in its local SQLite database. Use a **new**
 `COLLECTION` name for every meaningful run, especially after failed or partial
 indexing runs.

### Stage-Based Execution

Both shell drivers support running specific stages instead of the entire
 workflow. This is the safest way to debug issues and to avoid repeating heavy
 work.

## SciFact Workflow

SciFact is a small BEIR dataset and is the recommended starting point.

### What It Produces

Running `bench/run_scifact.sh` creates:

- `queries.jsonl`
- `qrels.jsonl`
- `qrels.test.tsv`
- `docs/`
- `results_seekx_*.jsonl`
- `results_seekx_*.trec`
- `benchmark_manifest.json`

### Main Environment Variables

- `DATA_DIR`: output directory, default `bench/data-scifact`
- `COLLECTION`: seekx collection name, default `scifact`
- `STAGES`: comma-separated stage list or `all`
- `PREP_MAX_DOCS`: optional corpus cap for smoke tests, default `0`
- `MAX_QUERIES`: optional query cap, default `0`
- `RUN_DEPTH`: TREC run depth, default `100`
- `EVAL_K`: `nDCG` cutoff, default `10`
- `RECALL_K`: recall cutoff, default `100`
- `ENABLE_RERANK`: `0` or `1`, default `0`
- `ENABLE_EXPAND`: `0` or `1`, default `0`
- `MIN_SCORE`: vector pre-fusion filter, default `0`
- `TREC_EVAL_BIN`: optional explicit path to `trec_eval`

### Fast Smoke Test

This is the cheapest way to confirm the full pipeline works:

```bash
DATA_DIR="bench/data-scifact-smoke" \
COLLECTION="scifact-smoke1" \
STAGES="prepare,index,search-baseline,evaluate" \
PREP_MAX_DOCS=300 \
MAX_QUERIES=10 \
RUN_DEPTH=20 \
ENABLE_RERANK=0 \
ENABLE_EXPAND=0 \
bash bench/run_scifact.sh
```

Notes:

- This validates the workflow, not retrieval quality.
- Small smoke subsets often produce `0.0000` metrics because they may exclude
  relevant documents for the sampled queries.

### Recommended First Real Run

Use the full SciFact corpus and either a limited or full query set.

Full corpus, 100 queries:

```bash
DATA_DIR="bench/data-scifact-baseline" \
COLLECTION="scifact-baseline-v1" \
STAGES="prepare,index,search-baseline,evaluate" \
PREP_MAX_DOCS=0 \
MAX_QUERIES=100 \
RUN_DEPTH=100 \
ENABLE_RERANK=0 \
ENABLE_EXPAND=0 \
bash bench/run_scifact.sh
```

Full corpus, full labeled query set:

```bash
DATA_DIR="bench/data-scifact-full" \
COLLECTION="scifact-full-v1" \
STAGES="prepare,index,search-baseline,evaluate" \
PREP_MAX_DOCS=0 \
MAX_QUERIES=0 \
RUN_DEPTH=100 \
ENABLE_RERANK=0 \
ENABLE_EXPAND=0 \
bash bench/run_scifact.sh
```

### Stage-by-Stage Commands

Prepare only:

```bash
DATA_DIR="bench/data-scifact-full" \
PREP_MAX_DOCS=0 \
MAX_QUERIES=0 \
STAGES="prepare" \
bash bench/run_scifact.sh
```

Index only:

```bash
DATA_DIR="bench/data-scifact-full" \
COLLECTION="scifact-full-v1" \
STAGES="index" \
bash bench/run_scifact.sh
```

Baseline search and evaluation:

```bash
DATA_DIR="bench/data-scifact-full" \
COLLECTION="scifact-full-v1" \
STAGES="search-baseline,evaluate" \
RUN_DEPTH=100 \
ENABLE_RERANK=0 \
ENABLE_EXPAND=0 \
bash bench/run_scifact.sh
```

Full pipeline search and evaluation:

```bash
DATA_DIR="bench/data-scifact-full" \
COLLECTION="scifact-full-v1" \
STAGES="search-full,evaluate" \
RUN_DEPTH=100 \
ENABLE_RERANK=1 \
ENABLE_EXPAND=1 \
bash bench/run_scifact.sh
```

## MIRACL-zh Workflow

Use this when you need a Chinese benchmark with official-style MIRACL-zh
 inputs and TREC-style evaluation.

### What It Produces

Running `bench/run_all.sh` creates:

- `queries.jsonl`
- `qrels.jsonl`
- `topics.dev.tsv`
- `qrels.dev.tsv`
- `docs/`
- `results_seekx_*.jsonl`
- `results_seekx_*.trec`
- `benchmark_manifest.json`

### Main Environment Variables

- `DATA_DIR`: output directory, default `bench/data`
- `COLLECTION`: seekx collection name, default `miracl-zh`
- `STAGES`: comma-separated stage list or `all`
- `PREP_MAX_DOCS`: optional corpus cap for smoke tests, default `0`
- `MAX_QUERIES`: optional query cap for search only, default `0`
- `RUN_DEPTH`: TREC run depth, default `1000`
- `EVAL_K`: `nDCG` cutoff, default `10`
- `RECALL_K`: recall cutoff, default `100`
- `ENABLE_RERANK`: `0` or `1`, default `1`
- `ENABLE_EXPAND`: `0` or `1`, default `1`
- `MIN_SCORE`: vector pre-fusion filter, default `0`
- `HF_ENDPOINT`: optional Hugging Face mirror endpoint
- `TREC_EVAL_BIN`: optional explicit path to `trec_eval`

### Minimal MIRACL Smoke Test

This is useful only for validating the pipeline:

```bash
HF_ENDPOINT="https://hf-mirror.com" \
DATA_DIR="bench/data-smoke-official" \
COLLECTION="miracl-zh-smoke1" \
STAGES="prepare-topics-qrels,prepare-corpus,index,search-baseline,evaluate" \
PREP_MAX_DOCS=200 \
MAX_QUERIES=5 \
RUN_DEPTH=20 \
ENABLE_RERANK=0 \
ENABLE_EXPAND=0 \
bash bench/run_all.sh
```

### Recommended Official-Style Baseline Sequence

Use separate stages and a fresh collection name:

Prepare topics and qrels:

```bash
HF_ENDPOINT="https://hf-mirror.com" \
DATA_DIR="bench/data-official" \
STAGES="prepare-topics-qrels" \
bash bench/run_all.sh
```

Prepare the full corpus:

```bash
HF_ENDPOINT="https://hf-mirror.com" \
DATA_DIR="bench/data-official" \
STAGES="prepare-corpus" \
bash bench/run_all.sh
```

Index:

```bash
DATA_DIR="bench/data-official" \
COLLECTION="miracl-zh-official-v1" \
STAGES="index" \
bash bench/run_all.sh
```

Run the baseline and evaluate:

```bash
DATA_DIR="bench/data-official" \
COLLECTION="miracl-zh-official-v1" \
STAGES="search-baseline,evaluate" \
RUN_DEPTH=1000 \
ENABLE_RERANK=0 \
ENABLE_EXPAND=0 \
bash bench/run_all.sh
```

Run the enhanced pipeline and evaluate:

```bash
DATA_DIR="bench/data-official" \
COLLECTION="miracl-zh-official-v1" \
STAGES="search-full,evaluate" \
RUN_DEPTH=1000 \
ENABLE_RERANK=1 \
ENABLE_EXPAND=1 \
bash bench/run_all.sh
```

## Output Files

The most important outputs are:

- `results_seekx_hybrid.trec`: baseline TREC run
- `results_seekx_full.trec`: rerank/expand TREC run
- `qrels.dev.tsv` or `qrels.test.tsv`: evaluation labels
- `benchmark_manifest.json`: preparation metadata

Use the `.trec` files together with the matching qrels file if you want to
 re-run evaluation or compare against another system.

## Comparing Systems

When comparing `seekx` against another system such as `qmd`:

- use the same `DATA_DIR` corpus preparation output
- use the same query set
- use the same qrels file
- use the same `RUN_DEPTH`
- evaluate both systems with the same TREC metric configuration

For fast iteration and lower cost, prefer **SciFact** first.

## seekx vs qmd Comparison

This section describes a practical comparison workflow using **SciFact** as the
 shared benchmark dataset.

### Comparison Goal

Use the same:

- prepared SciFact corpus under `docs/`
- query set
- qrels file
- run depth
- evaluation script

Then compare:

- `seekx` baseline vs `qmd search`
- `seekx` vector / hybrid style runs vs `qmd vsearch` / `qmd query`

### Recommended Scope

Start with SciFact, not MIRACL-zh. It is much cheaper and easier to iterate on.

Recommended first comparison matrix:

- `seekx-hybrid`: `bench/run_scifact.sh` with `ENABLE_RERANK=0` and `ENABLE_EXPAND=0`
- `qmd-search`: keyword-only baseline
- `qmd-vsearch`: vector-only baseline
- `qmd-query`: hybrid + reranking baseline

If you want the fairest first-pass comparison, compare:

- `seekx-hybrid`
- `qmd-query`

Then optionally break the systems down into lexical and vector sub-modes.

### Shared Data Preparation

Prepare SciFact once and reuse the same `docs/`, `queries.jsonl`, and
 `qrels.test.tsv` for both systems:

```bash
DATA_DIR="bench/data-scifact-compare" \
PREP_MAX_DOCS=0 \
MAX_QUERIES=0 \
STAGES="prepare" \
bash bench/run_scifact.sh
```

This produces:

- `bench/data-scifact-compare/docs/`
- `bench/data-scifact-compare/queries.jsonl`
- `bench/data-scifact-compare/qrels.test.tsv`

### seekx Commands

Index SciFact in `seekx`:

```bash
DATA_DIR="bench/data-scifact-compare" \
COLLECTION="scifact-seekx-v1" \
STAGES="index" \
bash bench/run_scifact.sh
```

Run `seekx` baseline:

```bash
DATA_DIR="bench/data-scifact-compare" \
COLLECTION="scifact-seekx-v1" \
STAGES="search-baseline,evaluate" \
RUN_DEPTH=100 \
ENABLE_RERANK=0 \
ENABLE_EXPAND=0 \
bash bench/run_scifact.sh
```

Run `seekx` full pipeline:

```bash
DATA_DIR="bench/data-scifact-compare" \
COLLECTION="scifact-seekx-v1" \
STAGES="search-full,evaluate" \
RUN_DEPTH=100 \
ENABLE_RERANK=1 \
ENABLE_EXPAND=1 \
bash bench/run_scifact.sh
```

### qmd Setup

The exact qmd command set depends on your local qmd installation, but based on
 the public README the high-level flow is:

1. Add the SciFact docs directory as a qmd collection
2. Generate embeddings if you want vector or hybrid modes
3. Run `search`, `vsearch`, or `query`
4. Convert qmd output into a standard TREC run file
5. Evaluate with `bench/eval_trec.py`

Example setup:

```bash
qmd collection add bench/data-scifact-compare/docs --name scifact
qmd embed
qmd status
```

### qmd Command Matrix

Keyword-only:

```bash
qmd search "example query" -c scifact --json -n 100
```

Vector-only:

```bash
qmd vsearch "example query" -c scifact --json -n 100
```

Hybrid / reranked:

```bash
qmd query "example query" -c scifact --json -n 100
```

### Important Limitation

`qmd` does not natively emit a TREC run file in the README examples. To compare
 it fairly against `seekx`, you need a small wrapper script that:

- reads `bench/data-scifact-compare/queries.jsonl`
- runs one qmd command per query with `--json`
- extracts qmd result docids or file paths
- maps those file paths back to the SciFact docids
- writes a TREC run file

Suggested output names:

- `bench/data-scifact-compare/results_qmd_search.trec`
- `bench/data-scifact-compare/results_qmd_vsearch.trec`
- `bench/data-scifact-compare/results_qmd_query.trec`

### Mapping qmd Results Back To SciFact Docids

The SciFact preparation step writes one plaintext file per docid using the same
 reversible docid encoding as the MIRACL workflow. This means:

- the file path returned by qmd can be decoded back to the original SciFact docid
- both systems can be evaluated against the same `qrels.test.tsv`

If you build a qmd wrapper, reuse the docid decoding logic from
 `bench/miracl_benchmark.py` rather than inventing a new mapping.

### Unified Evaluation

Once both systems have produced TREC run files, evaluate them together:

```bash
python3 bench/eval_trec.py \
  --data-dir bench/data-scifact-compare \
  --qrels bench/data-scifact-compare/qrels.test.tsv \
  --runs \
    bench/data-scifact-compare/results_seekx_hybrid.trec \
    bench/data-scifact-compare/results_qmd_query.trec \
  --names seekx-hybrid qmd-query \
  --ndcg-k 10 \
  --recall-k 100
```

Compare more modes in one table:

```bash
python3 bench/eval_trec.py \
  --data-dir bench/data-scifact-compare \
  --qrels bench/data-scifact-compare/qrels.test.tsv \
  --runs \
    bench/data-scifact-compare/results_seekx_hybrid.trec \
    bench/data-scifact-compare/results_seekx_full.trec \
    bench/data-scifact-compare/results_qmd_search.trec \
    bench/data-scifact-compare/results_qmd_vsearch.trec \
    bench/data-scifact-compare/results_qmd_query.trec \
  --names \
    seekx-hybrid \
    seekx-full \
    qmd-search \
    qmd-vsearch \
    qmd-query \
  --ndcg-k 10 \
  --recall-k 100
```

### Recommended Comparison Order

Use this order to reduce confusion:

1. `seekx-hybrid` vs `qmd-search`
   This gives a low-cost lexical baseline comparison.
2. `seekx-hybrid` vs `qmd-vsearch`
   This shows whether the vector branch changes behavior substantially.
3. `seekx-full` vs `qmd-query`
   This is the closest product-level comparison.

### Reporting Notes

When writing up results, document:

- dataset: SciFact
- corpus size and query count
- run depth
- whether reranking and query expansion were enabled
- which qmd mode you used: `search`, `vsearch`, or `query`
- whether `trec_eval` or the fallback evaluator was used

### Practical Next Step

The current repository already supports the `seekx` side of this protocol.
 What is still missing for a fully automated side-by-side comparison is a qmd
 run exporter that converts qmd JSON output into TREC runs.

If you want, the next change should be a dedicated helper such as:

- `bench/run_qmd.py`

That script would make the `seekx vs qmd` comparison fully repeatable.

## Troubleshooting

### `database is locked`

This usually comes from the local `seekx` SQLite index state, not from the
 benchmark scripts themselves.

Recommended mitigation:

- use a new `COLLECTION` name
- avoid running multiple indexing jobs at the same time
- re-run from `search-baseline,evaluate` if `seekx status --json` already shows
  the collection and document counts

### `attempt to write a readonly database`

This usually indicates an environment or sandbox permission issue around the
 local `seekx` database path, not a benchmark format problem.

### `trec_eval not found`

The benchmark will still run using the in-repo evaluator. Install `trec_eval`
 if you need direct parity with the standard binary:

```bash
brew install trec_eval
```

### Metrics are all zero

Common causes:

- smoke-test subsets excluded relevant documents
- the collection was not fully indexed
- the wrong collection name was used during search
- vector search is unavailable and the lexical baseline is weak for the task

Check:

```bash
seekx status --json
```

## Tests

Run the benchmark helper tests:

```bash
python3 -m unittest bench.test_miracl_benchmark bench.test_scifact_prepare
```

These tests cover:

- qrels and query parsing
- reversible docid encoding
- chunk-to-document aggregation
- TREC run formatting
- fallback evaluation logic
- SciFact data preparation helpers

They do not validate full remote downloads or full-corpus indexing runs.
