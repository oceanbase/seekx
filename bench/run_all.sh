#!/usr/bin/env bash
# run_all.sh — End-to-end MIRACL-zh benchmark for seekx (BM25 + hybrid).
#
# Steps
# -----
#   1. Download MIRACL-zh and build corpus         (prepare_miracl_zh.py)
#   2. Index + embed corpus with seekx add          (seekx add — FTS + embedding in one pass)
#   3. Run hybrid baseline (BM25 + vec, no extras)  (run_seekx.py)
#   4. Run hybrid + rerank + expand                 (run_seekx.py --rerank --expand)
#   5. Evaluate and print table                     (eval_ir.py)
#
# Prerequisites
# -------------
#   - seekx installed and on PATH (seekx onboard already run)
#   - Python 3.11+ with huggingface_hub  (pip install huggingface_hub)
#   - SEEKX_API_KEY / SEEKX_BASE_URL set for embedding
#   - If behind a firewall: export HF_ENDPOINT=https://hf-mirror.com
#
# Quick start
# -----------
#   cd /path/to/seekx
#   bash bench/run_all.sh
#
# Options (environment variables)
# --------------------------------
#   DATA_DIR       Output directory for corpus/results  (default: bench/data)
#   COLLECTION     seekx collection name                (default: miracl-zh)
#   MAX_QUERIES    0 = all dev queries (393)            (default: 0)
#   TOP_K          Results per query                    (default: 10)
#   SEEKX_BIN      Path to seekx binary                (default: seekx)
#   ENABLE_RERANK  1 = enable reranker                  (default: 1)
#   ENABLE_EXPAND  1 = enable LLM query expansion       (default: 1)

set -euo pipefail

DATA_DIR="${DATA_DIR:-bench/data}"
COLLECTION="${COLLECTION:-miracl-zh}"
MAX_QUERIES="${MAX_QUERIES:-0}"
TOP_K="${TOP_K:-10}"
SEEKX_BIN="${SEEKX_BIN:-seekx}"
ENABLE_RERANK="${ENABLE_RERANK:-1}"
ENABLE_EXPAND="${ENABLE_EXPAND:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "=================================================="
echo "  seekx × MIRACL-zh Benchmark"
echo "=================================================="
echo "  data dir   : ${DATA_DIR}"
echo "  collection : ${COLLECTION}"
echo "  top-k      : ${TOP_K}"
echo "  max queries: ${MAX_QUERIES:-all}"
echo "  rerank     : ${ENABLE_RERANK}"
echo "  expand     : ${ENABLE_EXPAND}"
echo "=================================================="
echo

# ---------------------------------------------------------------------------
# Step 1: Prepare corpus
# ---------------------------------------------------------------------------
if [ -f "${DATA_DIR}/stats.json" ]; then
  echo "[Step 1] Corpus already prepared (${DATA_DIR}/stats.json found). Skipping."
else
  echo "[Step 1] Downloading MIRACL-zh and building corpus…"
  python3 bench/prepare_miracl_zh.py \
    --out-dir "${DATA_DIR}" \
    ${MAX_QUERIES:+--max-queries "${MAX_QUERIES}"}
fi

DOCS_DIR="${DATA_DIR}/docs"
echo

# ---------------------------------------------------------------------------
# Step 2: Index + embed corpus
# seekx add scans the directory, writes FTS rows, and calls the embed API
# for every chunk in a single pass — no separate reindex step needed.
# ---------------------------------------------------------------------------
echo "[Step 2] Indexing and embedding corpus with seekx add…"
"${SEEKX_BIN}" add "${DOCS_DIR}" --name "${COLLECTION}" 2>&1 | tail -5
echo

# ---------------------------------------------------------------------------
# Step 3: Run hybrid baseline (BM25 + vector, no rerank, no expand)
# ---------------------------------------------------------------------------
BASELINE_RESULTS="${DATA_DIR}/results_seekx_hybrid.jsonl"
echo "[Step 3] Running hybrid baseline (BM25 + vector, no rerank, no expand)…"

python3 bench/run_seekx.py \
  --data-dir "${DATA_DIR}" \
  --collection "${COLLECTION}" \
  --top-k "${TOP_K}" \
  --seekx "${SEEKX_BIN}" \
  ${MAX_QUERIES:+--max-queries "${MAX_QUERIES}"}

mv "${DATA_DIR}/results_seekx.jsonl" "${BASELINE_RESULTS}"
echo "  Baseline results → ${BASELINE_RESULTS}"
echo

# ---------------------------------------------------------------------------
# Step 4: Run hybrid + rerank + expand (full pipeline)
# ---------------------------------------------------------------------------
FULL_RESULTS="${DATA_DIR}/results_seekx_full.jsonl"
RERANK_FLAG=""
EXPAND_FLAG=""
[ "${ENABLE_RERANK}" = "1" ] && RERANK_FLAG="--rerank"
[ "${ENABLE_EXPAND}" = "1" ] && EXPAND_FLAG="--expand"

FULL_LABEL="hybrid"
[ "${ENABLE_RERANK}" = "1" ] && FULL_LABEL="${FULL_LABEL}+rerank"
[ "${ENABLE_EXPAND}" = "1" ] && FULL_LABEL="${FULL_LABEL}+expand"

echo "[Step 4] Running ${FULL_LABEL}…"

python3 bench/run_seekx.py \
  --data-dir "${DATA_DIR}" \
  --collection "${COLLECTION}" \
  --top-k "${TOP_K}" \
  --seekx "${SEEKX_BIN}" \
  ${RERANK_FLAG} \
  ${EXPAND_FLAG} \
  ${MAX_QUERIES:+--max-queries "${MAX_QUERIES}"}

mv "${DATA_DIR}/results_seekx.jsonl" "${FULL_RESULTS}"
echo "  Full results → ${FULL_RESULTS}"
echo

# ---------------------------------------------------------------------------
# Step 5: Evaluate
# ---------------------------------------------------------------------------
echo "[Step 5] Evaluating…"

python3 bench/eval_ir.py \
  --data-dir "${DATA_DIR}" \
  --results "${BASELINE_RESULTS}" "${FULL_RESULTS}" \
  --names "seekx-hybrid" "seekx-${FULL_LABEL}" \
  --k "${TOP_K}"

echo "Benchmark complete."
