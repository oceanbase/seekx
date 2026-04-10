#!/usr/bin/env bash
# run_scifact.sh — Small BEIR SciFact benchmark driver for seekx.

set -euo pipefail

DATA_DIR="${DATA_DIR:-bench/data-scifact}"
COLLECTION="${COLLECTION:-scifact}"
SEEKX_BIN="${SEEKX_BIN:-seekx}"
STAGES="${STAGES:-all}"
MAX_QUERIES="${MAX_QUERIES:-0}"
PREP_MAX_DOCS="${PREP_MAX_DOCS:-0}"
RUN_DEPTH="${RUN_DEPTH:-100}"
EVAL_K="${EVAL_K:-10}"
RECALL_K="${RECALL_K:-100}"
MIN_SCORE="${MIN_SCORE:-0}"
ENABLE_RERANK="${ENABLE_RERANK:-0}"
ENABLE_EXPAND="${ENABLE_EXPAND:-0}"
TREC_EVAL_BIN="${TREC_EVAL_BIN:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

DOCS_DIR="${DATA_DIR}/docs"
MANIFEST_PATH="${DATA_DIR}/benchmark_manifest.json"
QRELS_PATH="${DATA_DIR}/qrels.test.tsv"

BASELINE_JSONL="${DATA_DIR}/results_seekx_hybrid.jsonl"
BASELINE_TREC="${DATA_DIR}/results_seekx_hybrid.trec"
FULL_JSONL="${DATA_DIR}/results_seekx_full.jsonl"
FULL_TREC="${DATA_DIR}/results_seekx_full.trec"

stage_enabled() {
  local stage="$1"
  if [[ "${STAGES}" == "all" ]]; then
    return 0
  fi
  [[ ",${STAGES}," == *",${stage},"* ]]
}

echo "=================================================="
echo "  seekx × SciFact Benchmark"
echo "=================================================="
echo "  data dir      : ${DATA_DIR}"
echo "  collection    : ${COLLECTION}"
echo "  stages        : ${STAGES}"
echo "  run depth     : ${RUN_DEPTH}"
echo "  eval ndcg@k   : ${EVAL_K}"
echo "  eval recall@k : ${RECALL_K}"
echo "  rerank        : ${ENABLE_RERANK}"
echo "  expand        : ${ENABLE_EXPAND}"
echo "=================================================="
echo

if stage_enabled "prepare"; then
  echo "[Stage] prepare"
  PREP_ARGS=(
    python3 bench/prepare_scifact.py
    --out-dir "${DATA_DIR}"
    --max-docs "${PREP_MAX_DOCS}"
  )
  if [[ "${MAX_QUERIES}" != "0" ]]; then
    PREP_ARGS+=(--max-queries "${MAX_QUERIES}")
  fi
  "${PREP_ARGS[@]}"
  echo
fi

if stage_enabled "index"; then
  echo "[Stage] index"
  if [[ ! -d "${DOCS_DIR}" ]]; then
    echo "Corpus docs directory not found: ${DOCS_DIR}" >&2
    exit 1
  fi
  "${SEEKX_BIN}" add "${DOCS_DIR}" --name "${COLLECTION}"
  echo
fi

if stage_enabled "search-baseline"; then
  echo "[Stage] search-baseline"
  BASELINE_ARGS=(
    python3 bench/run_seekx.py
    --data-dir "${DATA_DIR}"
    --collection "${COLLECTION}"
    --run-depth "${RUN_DEPTH}"
    --min-score "${MIN_SCORE}"
    --seekx "${SEEKX_BIN}"
    --run-name "seekx-hybrid"
    --jsonl-out "${BASELINE_JSONL}"
    --trec-out "${BASELINE_TREC}"
  )
  if [[ "${MAX_QUERIES}" != "0" ]]; then
    BASELINE_ARGS+=(--max-queries "${MAX_QUERIES}")
  fi
  "${BASELINE_ARGS[@]}"
  echo
fi

if stage_enabled "search-full"; then
  echo "[Stage] search-full"
  FULL_LABEL="seekx-hybrid"
  FULL_ARGS=(
    python3 bench/run_seekx.py
    --data-dir "${DATA_DIR}"
    --collection "${COLLECTION}"
    --run-depth "${RUN_DEPTH}"
    --min-score "${MIN_SCORE}"
    --seekx "${SEEKX_BIN}"
    --jsonl-out "${FULL_JSONL}"
    --trec-out "${FULL_TREC}"
  )
  if [[ "${ENABLE_RERANK}" == "1" ]]; then
    FULL_LABEL="${FULL_LABEL}+rerank"
    FULL_ARGS+=(--rerank)
  fi
  if [[ "${ENABLE_EXPAND}" == "1" ]]; then
    FULL_LABEL="${FULL_LABEL}+expand"
    FULL_ARGS+=(--expand)
  fi
  FULL_ARGS+=(--run-name "${FULL_LABEL}")
  if [[ "${MAX_QUERIES}" != "0" ]]; then
    FULL_ARGS+=(--max-queries "${MAX_QUERIES}")
  fi
  "${FULL_ARGS[@]}"
  echo
fi

if stage_enabled "evaluate"; then
  echo "[Stage] evaluate"
  if [[ ! -f "${QRELS_PATH}" ]]; then
    echo "Qrels file not found: ${QRELS_PATH}" >&2
    exit 1
  fi

  declare -a RUN_PATHS=()
  declare -a RUN_NAMES=()
  if [[ -f "${BASELINE_TREC}" ]]; then
    RUN_PATHS+=("${BASELINE_TREC}")
    RUN_NAMES+=("seekx-hybrid")
  fi
  if [[ -f "${FULL_TREC}" ]]; then
    RUN_PATHS+=("${FULL_TREC}")
    FULL_NAME="seekx-hybrid"
    [[ "${ENABLE_RERANK}" == "1" ]] && FULL_NAME="${FULL_NAME}+rerank"
    [[ "${ENABLE_EXPAND}" == "1" ]] && FULL_NAME="${FULL_NAME}+expand"
    RUN_NAMES+=("${FULL_NAME}")
  fi
  if [[ ${#RUN_PATHS[@]} -eq 0 ]]; then
    echo "No TREC run files found under ${DATA_DIR}" >&2
    exit 1
  fi

  EVAL_ARGS=(
    python3 bench/eval_trec.py
    --data-dir "${DATA_DIR}"
    --qrels "${QRELS_PATH}"
    --runs "${RUN_PATHS[@]}"
    --names "${RUN_NAMES[@]}"
    --ndcg-k "${EVAL_K}"
    --recall-k "${RECALL_K}"
  )
  if [[ -n "${TREC_EVAL_BIN}" ]]; then
    EVAL_ARGS+=(--trec-eval-bin "${TREC_EVAL_BIN}")
  fi
  "${EVAL_ARGS[@]}"
  echo
fi

echo "SciFact benchmark workflow complete."
echo "  Manifest : ${MANIFEST_PATH}"
echo "  Qrels    : ${QRELS_PATH}"
