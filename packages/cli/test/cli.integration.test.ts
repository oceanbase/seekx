import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import type { IndexProgressEvent, SearchProgressEvent } from "@seekx/core";
import { openDatabase } from "@seekx/core";
import { Store } from "@seekx/core";
import { createProgram } from "../src/program.ts";
import {
  createIndexProgressReporter,
  createSearchProgressReporter,
  createStatusReporter,
} from "../src/progress.ts";

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`);
  }
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let tempRoot: string;
let configPath: string;
let dbPath: string;
let docsPath: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  tempRoot = join(tmpdir(), `seekx-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  configPath = join(tempRoot, "config.yml");
  dbPath = join(tempRoot, "index.sqlite");
  docsPath = join(tempRoot, "docs");

  mkdirSync(docsPath, { recursive: true });
  writeFileSync(configPath, "# test config\n", "utf-8");

  originalEnv = {
    SEEKX_CONFIG_PATH: process.env.SEEKX_CONFIG_PATH,
    SEEKX_DB_PATH: process.env.SEEKX_DB_PATH,
  };
  process.env.SEEKX_CONFIG_PATH = configPath;
  process.env.SEEKX_DB_PATH = dbPath;
});

afterEach(() => {
  process.env.SEEKX_CONFIG_PATH = originalEnv.SEEKX_CONFIG_PATH;
  process.env.SEEKX_DB_PATH = originalEnv.SEEKX_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<CliResult> {
  const program = createProgram();
  let stdout = "";
  let stderr = "";

  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  console.log = (...messages: unknown[]) => {
    stdout += `${format(...messages)}\n`;
  };
  console.error = (...messages: unknown[]) => {
    stderr += `${format(...messages)}\n`;
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0);
  }) as typeof process.exit;

  try {
    await program.parseAsync(args, { from: "user" });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (error instanceof CliExit) {
      return { stdout, stderr, exitCode: error.code };
    }
    throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }
}

function openStore(): Store {
  const db = openDatabase(dbPath);
  return new Store(db, false);
}

describe("createIndexProgressReporter", () => {
  test("renders a two-phase progress UI on TTY streams", () => {
    let output = "";
    const reporter = createIndexProgressReporter({
      enabled: true,
      stream: {
        isTTY: true,
        columns: 80,
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
    });

    const events: IndexProgressEvent[] = [
      { phase: "scan_start", rootPath: "/tmp/docs" },
      {
        phase: "scan_progress",
        rootPath: "/tmp/docs",
        discovered: 1,
        filePath: "/tmp/docs/intro.md",
        relativePath: "intro.md",
      },
      { phase: "scan_done", rootPath: "/tmp/docs", totalFiles: 2 },
      { phase: "index_start", rootPath: "/tmp/docs", totalFiles: 2 },
      {
        phase: "index_progress",
        rootPath: "/tmp/docs",
        completed: 1,
        totalFiles: 2,
        filePath: "/tmp/docs/intro.md",
        relativePath: "intro.md",
        status: "indexed",
      },
      {
        phase: "index_progress",
        rootPath: "/tmp/docs",
        completed: 2,
        totalFiles: 2,
        filePath: "/tmp/docs/nested/child.txt",
        relativePath: "nested/child.txt",
        status: "indexed",
      },
      {
        phase: "done",
        rootPath: "/tmp/docs",
        indexed: 2,
        skipped: 0,
        errors: 0,
        totalFiles: 2,
      },
    ];

    for (const event of events) reporter(event);

    expect(output).toContain("Scanning files... 1");
    expect(output).toContain("Scanning files... done (2 files)\n");
    expect(output).toContain("0/2   0%  Preparing index...");
    expect(output).toContain("[");
    expect(output).toContain("2/2 100%");
    expect(output).toContain("nested/child.txt");
    expect(output.endsWith("\n")).toBe(true);
  });
});

describe("status and search reporters", () => {
  test("renders search phase updates on a tty stream", () => {
    let output = "";
    const reporter = createSearchProgressReporter({
      enabled: true,
      stream: {
        isTTY: true,
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
    });

    const events: SearchProgressEvent[] = [
      { phase: "start", mode: "hybrid", useExpand: true, useRerank: true },
      { phase: "expand_start", query: "vector db" },
      { phase: "expand_done", expandedQueries: ["vector db", "embedding index"] },
      { phase: "bm25_start", totalQueries: 2 },
      { phase: "bm25_progress", completed: 1, totalQueries: 2, query: "vector db" },
      { phase: "vector_start", totalQueries: 2 },
      { phase: "vector_progress", completed: 2, totalQueries: 2, query: "embedding index" },
      { phase: "rerank_start", candidateCount: 20 },
      { phase: "rerank_done", candidateCount: 20, applied: true },
      { phase: "done", resultCount: 5, warningCount: 0 },
    ];

    for (const event of events) reporter.onProgress(event);
    reporter.finish();

    expect(output).toContain("Preparing search...");
    expect(output).toContain("Expanding query...");
    expect(output).toContain("Running BM25 search (1/2)...");
    expect(output).toContain("Reranking complete (20 candidates).");
    expect(output.endsWith("\r\x1b[2K")).toBe(true);
  });

  test("writes one-shot status lines for non-tty streams", () => {
    let output = "";
    const reporter = createStatusReporter({
      enabled: true,
      stream: {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
    });

    reporter.update("Checking API health...");
    reporter.update("Checking API health...");
    reporter.update("Loading collections...");

    expect(output).toBe("Checking API health...\nLoading collections...\n");
  });
});

describe("CLI integration", () => {
  test("config set and print redact API keys end-to-end", async () => {
    const setResult = await runCli(["config", "embed.api_key", "sk-secret"]);
    expect(setResult.exitCode).toBe(0);
    expect(setResult.stdout).toContain("Set embed.api_key = ***");

    const printResult = await runCli(["config"]);
    expect(printResult.exitCode).toBe(0);
    expect(printResult.stdout).not.toContain("sk-secret");
    expect(readFileSync(configPath, "utf-8")).toContain("sk-secret");
  });

  test("config exits with user error for unknown keys", async () => {
    const result = await runCli(["config", "missing.key"]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Unknown config key: missing.key");
  });

  test("add, collections, status, and get work together on a temporary index", async () => {
    writeFileSync(join(docsPath, "intro.md"), "# Intro\n\nHello seekx.\n", "utf-8");
    writeFileSync(join(docsPath, "notes.txt"), "Line one.\n\nLine two.\n", "utf-8");
    const indexedDocsPath = realpathSync(docsPath);
    const indexedIntroPath = realpathSync(join(docsPath, "intro.md"));

    const addResult = await runCli(["add", docsPath, "--name", "docs"]);
    expect(addResult.exitCode).toBe(0);
    expect(addResult.stdout).toContain(`Indexing 'docs' → ${indexedDocsPath}`);
    expect(addResult.stdout).toContain("Scanning files...\n");
    expect(addResult.stdout).toContain("Scanning files... 1");
    expect(addResult.stdout).toContain("Scanning files... done (2 files)");
    expect(addResult.stdout).toContain("Indexing files... 0% (0/2)");
    expect(addResult.stdout).toContain("Indexing files... 50% (1/2)");
    expect(addResult.stdout).toContain("Indexing files... 100% (2/2)");
    expect(addResult.stdout).toContain("Done. Indexed 2 files, skipped 0.");

    const collectionsResult = await runCli(["collections"]);
    expect(collectionsResult.exitCode).toBe(0);
    expect(collectionsResult.stdout).toContain("docs");
    expect(collectionsResult.stdout).toContain(indexedDocsPath);

    const collectionsJson = await runCli(["collections", "--json"]);
    expect(collectionsJson.exitCode).toBe(0);
    expect(collectionsJson.stdout.trim().startsWith("[")).toBe(true);
    const collectionRows = JSON.parse(collectionsJson.stdout.trim()) as Array<{ name: string }>;
    expect(collectionRows.some((r) => r.name === "docs")).toBe(true);

    const statusResult = await runCli(["status"]);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain("seekx status");
    expect(statusResult.stdout).toContain(dbPath);
    expect(statusResult.stdout).toContain("documents    2");
    expect(statusResult.stdout).toContain("sqlite-vec");

    const store = openStore();
    try {
      const doc = store.findDocumentByPath("docs", indexedIntroPath);
      expect(doc).not.toBeNull();
      if (!doc) throw new Error("Expected indexed document");

      const getResult = await runCli(["get", store.encodeDocid(doc.id)]);
      expect(getResult.exitCode).toBe(0);
      expect(getResult.stdout).toContain(indexedIntroPath);
      expect(getResult.stdout).toContain("Intro");
      expect(getResult.stdout).toContain("Hello seekx.");
    } finally {
      store.close();
    }
  });

  test("add returns a user error for missing paths", async () => {
    const missingPath = join(tempRoot, "missing");
    expect(existsSync(missingPath)).toBe(false);

    const result = await runCli(["add", missingPath]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Path does not exist");
  });

  test("add --json suppresses progress output", async () => {
    writeFileSync(join(docsPath, "intro.md"), "# Intro\n\nHello seekx.\n", "utf-8");

    const result = await runCli(["add", docsPath, "--name", "docs", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Scanning files...");
    expect(result.stdout).not.toContain("Indexing files...");
    const parsed = JSON.parse(result.stdout.trim()) as { name: string; totalFiles: number };
    expect(parsed.name).toBe("docs");
    expect(parsed.totalFiles).toBe(1);
  });

  test("search prints phase updates to stderr without polluting results", async () => {
    writeFileSync(join(docsPath, "intro.md"), "# Vector Notes\n\nVector database overview.\n", "utf-8");
    await runCli(["add", docsPath, "--name", "docs"]);

    const result = await runCli(["search", "vector", "--no-expand"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Preparing search...");
    expect(result.stderr).toContain("Running BM25 search...");
    expect(result.stdout).toContain("Vector Notes");
    expect(result.stdout).not.toContain("Preparing search...");
  });

  test("search uses config default_limit when --limit is omitted", async () => {
    writeFileSync(configPath, "search:\n  default_limit: 1\n", "utf-8");
    writeFileSync(join(docsPath, "a.md"), "# Alpha\n\nseekx notes.\n", "utf-8");
    writeFileSync(join(docsPath, "b.md"), "# Beta\n\nmore seekx notes.\n", "utf-8");
    await runCli(["add", docsPath, "--name", "docs"]);

    const result = await runCli(["search", "seekx", "--json", "--no-expand"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      results: Array<{ file: string; score: number }>;
    };
    expect(parsed.results).toHaveLength(1);
  });

});
