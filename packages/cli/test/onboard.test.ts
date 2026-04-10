/**
 * onboard.test.ts
 *
 * Tests for `seekx onboard --yes` (non-interactive mode).
 *
 * All cases use --skip-health-check and --no-watch to avoid live API calls
 * and daemon spawning. The tests verify:
 *   - Exit code and error messages for missing required inputs.
 *   - Correct config file contents when all required env vars are present.
 *
 * Run: bun test packages/cli/test/onboard.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { createProgram } from "../src/program.ts";

// ---------------------------------------------------------------------------
// Env vars managed across every test case
// ---------------------------------------------------------------------------

const ONBOARD_ENV_KEYS = [
  "SEEKX_CONFIG_PATH",
  "SEEKX_DB_PATH",
  "SEEKX_PROVIDER",
  "SEEKX_API_KEY",
  "SEEKX_BASE_URL",
  "SEEKX_EMBED_MODEL",
  "SEEKX_RERANK_MODEL",
  "SEEKX_EXPAND_MODEL",
  "SEEKX_RERANK_BASE_URL",
  "SEEKX_RERANK_API_KEY",
  "SEEKX_EXPAND_BASE_URL",
  "SEEKX_EXPAND_API_KEY",
] as const;

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
let savedEnv: Partial<Record<string, string | undefined>>;

beforeEach(() => {
  tempRoot = join(
    tmpdir(),
    `seekx-onboard-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(tempRoot, { recursive: true });
  configPath = join(tempRoot, "config.yml");
  dbPath = join(tempRoot, "index.sqlite");

  // Save and reset all relevant env vars.
  savedEnv = {};
  for (const key of ONBOARD_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  process.env.SEEKX_CONFIG_PATH = configPath;
  process.env.SEEKX_DB_PATH = dbPath;
});

afterEach(() => {
  for (const key of ONBOARD_ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
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

// ---------------------------------------------------------------------------
// Error cases: missing required inputs
// ---------------------------------------------------------------------------

describe("onboard --yes error cases", () => {
  test("exits with code 2 when --provider is not supplied", async () => {
    const result = await runCli(["onboard", "--yes", "--skip-health-check", "--no-watch"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Provider is required in non-interactive mode");
    expect(result.stderr).toContain("--provider");
  });

  test("exits with code 2 for an unknown provider key", async () => {
    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "notaprovider",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown provider 'notaprovider'");
  });

  test("exits with code 2 when SEEKX_PROVIDER env var holds an unknown key", async () => {
    process.env.SEEKX_PROVIDER = "bad_preset";
    const result = await runCli(["onboard", "--yes", "--skip-health-check", "--no-watch"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown provider 'bad_preset'");
  });

  test("exits with code 2 for siliconflow when SEEKX_API_KEY is missing", async () => {
    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "siliconflow",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("API key");
    expect(result.stderr).toContain("SEEKX_API_KEY");
  });

  test("exits with code 2 for custom provider when SEEKX_BASE_URL is missing", async () => {
    process.env.SEEKX_API_KEY = "sk-test";
    // SEEKX_EMBED_MODEL is also required for custom but BASE_URL is checked first
    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "custom",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("SEEKX_BASE_URL");
  });

  test("exits with code 2 for custom provider when SEEKX_EMBED_MODEL is missing", async () => {
    process.env.SEEKX_API_KEY = "sk-test";
    process.env.SEEKX_BASE_URL = "https://api.example.com/v1";
    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "custom",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("SEEKX_EMBED_MODEL");
  });
});

// ---------------------------------------------------------------------------
// Happy-path cases: config written correctly
// ---------------------------------------------------------------------------

describe("onboard --yes happy paths", () => {
  test("ollama preset succeeds without API key and writes correct config", async () => {
    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "ollama",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Config written to");

    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("http://localhost:11434/v1");
    expect(config).toContain("nomic-embed-text");
    // No rerank or expand for ollama
    expect(config).not.toContain("rerank:");
    expect(config).not.toContain("expand:");
  });

  test("siliconflow preset with API key writes correct config", async () => {
    process.env.SEEKX_API_KEY = "sk-siliconflow-test";

    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "siliconflow",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);

    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("https://api.siliconflow.cn/v1");
    expect(config).toContain("sk-siliconflow-test");
    expect(config).toContain("BAAI/bge-m3");
    // siliconflow has rerank and expand defaults
    expect(config).toContain("BAAI/bge-reranker-v2-m3");
    expect(config).toContain("Qwen/Qwen3-8B");
  });

  test("SEEKX_PROVIDER env var selects a valid preset", async () => {
    process.env.SEEKX_PROVIDER = "ollama";

    const result = await runCli(["onboard", "--yes", "--skip-health-check", "--no-watch"]);

    expect(result.exitCode).toBe(0);
    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("http://localhost:11434/v1");
  });

  test("SEEKX_EMBED_MODEL env var overrides preset default", async () => {
    process.env.SEEKX_API_KEY = "sk-test";
    process.env.SEEKX_EMBED_MODEL = "custom-embed-model";

    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "siliconflow",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);
    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("custom-embed-model");
    expect(config).not.toContain("BAAI/bge-m3");
  });

  test("custom provider with all required env vars writes correct config", async () => {
    process.env.SEEKX_BASE_URL = "https://api.custom.io/v1";
    process.env.SEEKX_API_KEY = "sk-custom";
    process.env.SEEKX_EMBED_MODEL = "my-embed-model";

    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "custom",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);
    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("https://api.custom.io/v1");
    expect(config).toContain("sk-custom");
    expect(config).toContain("my-embed-model");
    // No rerank/expand in --yes without SEEKX_RERANK_MODEL / SEEKX_EXPAND_MODEL
    expect(config).not.toContain("rerank:");
    expect(config).not.toContain("expand:");
  });

  test("custom provider enables rerank when SEEKX_RERANK_MODEL is set", async () => {
    process.env.SEEKX_BASE_URL = "https://api.custom.io/v1";
    process.env.SEEKX_API_KEY = "sk-custom";
    process.env.SEEKX_EMBED_MODEL = "my-embed-model";
    process.env.SEEKX_RERANK_MODEL = "my-rerank-model";

    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "custom",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);
    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("my-rerank-model");
  });

  test("--no-watch flag suppresses daemon start message", async () => {
    process.env.SEEKX_API_KEY = "sk-test";

    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "siliconflow",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Real-time indexer started");
    expect(result.stdout).toContain("seekx watch");
  });

  test("overwrites an existing config.yml without error", async () => {
    // Pre-create a config file with stale values.
    writeFileSync(configPath, "embed:\n  base_url: https://old.api\n", "utf-8");

    process.env.SEEKX_API_KEY = "sk-new";

    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "siliconflow",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);
    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("https://api.siliconflow.cn/v1");
    expect(config).not.toContain("https://old.api");
  });

  test("prints non-interactive mode notice when --yes is passed", async () => {
    process.env.SEEKX_API_KEY = "sk-test";

    const result = await runCli([
      "onboard",
      "--yes",
      "--provider",
      "siliconflow",
      "--skip-health-check",
      "--no-watch",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("non-interactive mode");
  });
});
