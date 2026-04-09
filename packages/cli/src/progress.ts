import type {
  IndexProgressCallback,
  IndexProgressEvent,
  SearchProgressCallback,
  SearchProgressEvent,
} from "seekx-core";

interface ProgressStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
}

interface CreateIndexProgressReporterOptions {
  enabled: boolean;
  stream?: ProgressStream;
}

export function createIndexProgressReporter(
  options: CreateIndexProgressReporterOptions,
): IndexProgressCallback {
  if (!options.enabled) {
    return () => {};
  }

  const stream = options.stream ?? process.stdout;
  const isTTY = Boolean(stream.isTTY);
  let ttyLineActive = false;
  let lastScanCheckpoint = 0;
  let lastIndexBucket = -1;
  let scanStarted = false;

  return (event) => {
    if (isTTY) {
      handleTTYEvent(stream, event);
      return;
    }

    handlePlainEvent(stream, event);
  };

  function handleTTYEvent(target: ProgressStream, event: IndexProgressEvent): void {
    switch (event.phase) {
      case "scan_start":
        scanStarted = true;
        writeTTYLine(target, "Scanning files...");
        return;
      case "scan_progress":
        if (event.discovered === 1 || event.discovered - lastScanCheckpoint >= 25) {
          lastScanCheckpoint = event.discovered;
          writeTTYLine(target, `Scanning files... ${event.discovered}`);
        }
        return;
      case "scan_done":
        writeTTYLine(target, `Scanning files... done (${event.totalFiles} files)`);
        target.write("\n");
        ttyLineActive = false;
        return;
      case "index_start":
        if (event.totalFiles === 0) return;
        writeTTYLine(target, formatIndexStartLine(event.totalFiles, target.columns));
        return;
      case "index_progress":
        if (event.totalFiles === 0) return;
        writeTTYLine(target, formatIndexLine(event, target.columns));
        return;
      case "done":
        if (ttyLineActive) {
          target.write("\n");
          ttyLineActive = false;
        }
        return;
    }
  }

  function handlePlainEvent(target: ProgressStream, event: IndexProgressEvent): void {
    switch (event.phase) {
      case "scan_start":
        if (!scanStarted) {
          scanStarted = true;
          target.write("Scanning files...\n");
        }
        return;
      case "scan_progress":
        if (
          event.discovered === 1 ||
          event.discovered - lastScanCheckpoint >= 50
        ) {
          lastScanCheckpoint = event.discovered;
          target.write(`Scanning files... ${event.discovered}\n`);
        }
        return;
      case "scan_done":
        target.write(`Scanning files... done (${event.totalFiles} files)\n`);
        return;
      case "index_start":
        if (event.totalFiles > 0) {
          target.write(`Indexing files... 0% (0/${event.totalFiles})\n`);
        }
        return;
      case "index_progress": {
        if (event.totalFiles === 0) return;
        const bucket = Math.floor((event.completed / event.totalFiles) * 10);
        if (event.completed !== 1 && event.completed !== event.totalFiles && bucket <= lastIndexBucket) {
          return;
        }
        lastIndexBucket = bucket;
        target.write(
          `Indexing files... ${formatPercent(event.completed, event.totalFiles)} (${event.completed}/${event.totalFiles}) ${event.relativePath}\n`,
        );
        return;
      }
      case "done":
        return;
    }
  }

  function writeTTYLine(target: ProgressStream, line: string): void {
    ttyLineActive = true;
    target.write(`\r\x1b[2K${line}`);
  }
}

export function createSearchProgressReporter(options: {
  enabled: boolean;
  stream?: ProgressStream;
}): { onProgress: SearchProgressCallback; finish: () => void } {
  const status = createStatusReporter(options);
  return {
    onProgress(event) {
      const message = formatSearchProgressMessage(event);
      if (message) status.update(message);
    },
    finish() {
      status.clear();
    },
  };
}

export function createStatusReporter(options: {
  enabled: boolean;
  stream?: ProgressStream;
}): {
  update: (message: string) => void;
  clear: () => void;
} {
  if (!options.enabled) {
    return { update() {}, clear() {} };
  }

  const stream = options.stream ?? process.stderr;
  const isTTY = Boolean(stream.isTTY);
  let ttyLineActive = false;
  let lastPlainMessage = "";

  return {
    update(message: string) {
      if (isTTY) {
        ttyLineActive = true;
        stream.write(`\r\x1b[2K${message}`);
        return;
      }
      if (message === lastPlainMessage) return;
      lastPlainMessage = message;
      stream.write(`${message}\n`);
    },
    clear() {
      if (isTTY && ttyLineActive) {
        stream.write("\r\x1b[2K");
        ttyLineActive = false;
      }
    },
  };
}

function formatIndexLine(
  event: Extract<IndexProgressEvent, { phase: "index_progress" }>,
  terminalColumns?: number,
): string {
  const barWidth = clamp(getBarWidth(terminalColumns), 10, 40);
  const percent = Math.round((event.completed / event.totalFiles) * 100);
  const filled = Math.round((barWidth * event.completed) / event.totalFiles);
  const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
  const prefix =
    `[${bar}] ${event.completed}/${event.totalFiles} ${String(percent).padStart(3, " ")}%  `;
  const maxPathWidth = Math.max(12, (terminalColumns ?? 80) - prefix.length);
  return `${prefix}${truncateLeft(event.relativePath, maxPathWidth)}`;
}

function formatIndexStartLine(totalFiles: number, terminalColumns?: number): string {
  const barWidth = clamp(getBarWidth(terminalColumns), 10, 40);
  const prefix = `[${"-".repeat(barWidth)}] 0/${totalFiles}   0%  `;
  return `${prefix}Preparing index...`;
}

function formatSearchProgressMessage(event: SearchProgressEvent): string | null {
  switch (event.phase) {
    case "start":
      return event.mode === "vector" ? "Preparing vector search..." : "Preparing search...";
    case "expand_start":
      return "Expanding query...";
    case "expand_done":
      return event.expandedQueries.length > 1
        ? `Expanded into ${event.expandedQueries.length} queries.`
        : "Expansion complete.";
    case "bm25_start":
      return event.totalQueries > 1
        ? `Running BM25 search across ${event.totalQueries} queries...`
        : "Running BM25 search...";
    case "bm25_progress":
      return event.totalQueries > 1
        ? `Running BM25 search (${event.completed}/${event.totalQueries})...`
        : "Running BM25 search...";
    case "vector_start":
      return event.totalQueries > 1
        ? `Embedding and vector searching ${event.totalQueries} queries...`
        : "Embedding query and running vector search...";
    case "vector_progress":
      return event.totalQueries > 1
        ? `Embedding and vector searching (${event.completed}/${event.totalQueries})...`
        : "Embedding query and running vector search...";
    case "hyde_start":
      return "Generating hypothetical answer (HyDE)...";
    case "hyde_done":
      return event.success ? "HyDE vector search complete." : "HyDE skipped.";
    case "rerank_start":
      return `Reranking top ${event.candidateCount} candidates...`;
    case "rerank_done":
      return event.applied
        ? `Reranking complete (${event.candidateCount} candidates).`
        : "Rerank unavailable; using fused ranking.";
    case "done":
      return null;
  }
}

function getBarWidth(terminalColumns?: number): number {
  if (!terminalColumns || terminalColumns >= 100) return 40;
  if (terminalColumns >= 80) return 28;
  if (terminalColumns >= 60) return 20;
  return 12;
}

function truncateLeft(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 3) return value.slice(-maxWidth);
  return `...${value.slice(-(maxWidth - 3))}`;
}

function formatPercent(completed: number, total: number): string {
  return `${Math.round((completed / total) * 100)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
