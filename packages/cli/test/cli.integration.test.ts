import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { openDatabase } from "@seekx/core";
import { Store } from "@seekx/core";
import { createProgram } from "../src/program.ts";

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

  console.log = (...messages: unknown[]) => {
    stdout += `${format(...messages)}\n`;
  };
  console.error = (...messages: unknown[]) => {
    stderr += `${format(...messages)}\n`;
  };
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
    process.exit = originalExit;
  }
}

function openStore(): Store {
  const db = openDatabase(dbPath);
  return new Store(db, false);
}

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
    expect(addResult.stdout).toContain("Done. Indexed 2 files, skipped 0.");

    const collectionsResult = await runCli(["collections"]);
    expect(collectionsResult.exitCode).toBe(0);
    expect(collectionsResult.stdout).toContain("docs");
    expect(collectionsResult.stdout).toContain(indexedDocsPath);

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
});
