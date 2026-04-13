/**
 * config.test.ts — Unit tests for resolvePluginConfig.
 *
 * Tests the three-layer precedence:
 *   pluginConfig (raw) > ~/.seekx/config.yml (base) > built-in defaults
 *
 * resolvePluginConfig accepts an optional loadConfigFn parameter for
 * dependency injection, so no global module mocking is required.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "seekx-core";
import { resolvePluginConfig } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Construct a complete ResolvedConfig for use as the seekx base config. */
function makeBase(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    embed: { baseUrl: "https://base.example.com/v1", apiKey: "base-key", model: "bge-base" },
    rerank: { baseUrl: "https://base.example.com/v1", apiKey: "base-key", model: "reranker-base" },
    expand: { baseUrl: "https://base.example.com/v1", apiKey: "base-key", model: "expand-base" },
    search: { defaultLimit: 10, rerank: true, minScore: 0.0, minResultScore: 0.0 },
    watch: { debounceMs: 500, ignore: [] },
    dbPath: join(homedir(), ".seekx", "index.sqlite"),
    configPath: join(homedir(), ".seekx", "config.yml"),
    ...overrides,
  };
}

/** loadConfigFn stub that returns null (no seekx config file). */
const noBase = () => null;

// ---------------------------------------------------------------------------

describe("resolvePluginConfig — defaults (no seekx config, empty plugin config)", () => {
  test("dbPath defaults to ~/.seekx/openclaw.db", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.dbPath).toBe(join(homedir(), ".seekx", "openclaw.db"));
  });

  test("extraPaths is empty", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.extraPaths).toEqual([]);
  });

  test("searchLimit defaults to 6", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.searchLimit).toBe(6);
  });

  test("refreshIntervalMs defaults to 300000", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.refreshIntervalMs).toBe(300_000);
  });

  test("includeOpenClawMemory defaults to true", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.includeOpenClawMemory).toBe(true);
  });

  test("embed fields are empty strings when nothing is configured", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.embed.baseUrl).toBe("");
    expect(cfg.embed.apiKey).toBe("");
    expect(cfg.embed.model).toBe("");
  });

  test("rerank and expand are null when nothing is configured", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.rerank).toBeNull();
    expect(cfg.expand).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("resolvePluginConfig — inherits from ~/.seekx/config.yml", () => {
  test("embed fields come from base config when not overridden", () => {
    const cfg = resolvePluginConfig({}, () => makeBase());
    expect(cfg.embed.baseUrl).toBe("https://base.example.com/v1");
    expect(cfg.embed.apiKey).toBe("base-key");
    expect(cfg.embed.model).toBe("bge-base");
  });

  test("rerank endpoint comes from base config", () => {
    const cfg = resolvePluginConfig({}, () => makeBase());
    expect(cfg.rerank).not.toBeNull();
    expect(cfg.rerank?.model).toBe("reranker-base");
  });

  test("expand endpoint comes from base config", () => {
    const cfg = resolvePluginConfig({}, () => makeBase());
    expect(cfg.expand?.model).toBe("expand-base");
  });

  test("base config without rerank/expand keeps them null", () => {
    const cfg = resolvePluginConfig({}, () => makeBase({ rerank: null, expand: null }));
    expect(cfg.rerank).toBeNull();
    expect(cfg.expand).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("resolvePluginConfig — plugin config overrides base config", () => {
  test("plugin apiKey overrides base apiKey", () => {
    const cfg = resolvePluginConfig({ apiKey: "plugin-key" }, () => makeBase());
    expect(cfg.embed.apiKey).toBe("plugin-key");
  });

  test("plugin baseUrl overrides base baseUrl", () => {
    const cfg = resolvePluginConfig(
      { baseUrl: "https://plugin.example.com/v1" },
      () => makeBase(),
    );
    expect(cfg.embed.baseUrl).toBe("https://plugin.example.com/v1");
  });

  test("plugin embedModel overrides base model", () => {
    const cfg = resolvePluginConfig({ embedModel: "bge-large" }, () => makeBase());
    expect(cfg.embed.model).toBe("bge-large");
  });

  test("plugin rerankModel builds endpoint with plugin baseUrl/apiKey", () => {
    const cfg = resolvePluginConfig(
      { baseUrl: "https://plugin.example.com/v1", apiKey: "plugin-key", rerankModel: "reranker-v2" },
      () => makeBase(),
    );
    expect(cfg.rerank?.model).toBe("reranker-v2");
    expect(cfg.rerank?.baseUrl).toBe("https://plugin.example.com/v1");
    expect(cfg.rerank?.apiKey).toBe("plugin-key");
  });

  test("plugin expandModel builds endpoint with plugin baseUrl/apiKey", () => {
    const cfg = resolvePluginConfig(
      { baseUrl: "https://plugin.example.com/v1", apiKey: "plugin-key", expandModel: "expand-v1" },
      () => makeBase(),
    );
    expect(cfg.expand?.model).toBe("expand-v1");
    expect(cfg.expand?.baseUrl).toBe("https://plugin.example.com/v1");
  });

  test("plugin dbPath overrides default", () => {
    const cfg = resolvePluginConfig({ dbPath: "/custom/path/db.sqlite" }, noBase);
    expect(cfg.dbPath).toBe("/custom/path/db.sqlite");
  });

  test("plugin searchLimit overrides default", () => {
    const cfg = resolvePluginConfig({ searchLimit: 12 }, noBase);
    expect(cfg.searchLimit).toBe(12);
  });

  test("plugin refreshIntervalMs overrides default", () => {
    const cfg = resolvePluginConfig({ refreshIntervalMs: 60_000 }, noBase);
    expect(cfg.refreshIntervalMs).toBe(60_000);
  });

  test("plugin includeOpenClawMemory:false overrides default", () => {
    const cfg = resolvePluginConfig({ includeOpenClawMemory: false }, noBase);
    expect(cfg.includeOpenClawMemory).toBe(false);
  });

  test("plugin paths are preserved", () => {
    const paths = [{ name: "notes", path: "~/notes" }];
    const cfg = resolvePluginConfig({ paths }, noBase);
    expect(cfg.extraPaths).toEqual(paths);
  });

  test("full plugin config with no base: all fields from plugin", () => {
    const cfg = resolvePluginConfig(
      {
        apiKey: "sk-xxx",
        baseUrl: "https://api.siliconflow.cn/v1",
        embedModel: "BAAI/bge-large-zh-v1.5",
        rerankModel: "BAAI/bge-reranker-v2-m3",
        expandModel: "Qwen/Qwen3-8B",
        searchLimit: 8,
        refreshIntervalMs: 120_000,
        includeOpenClawMemory: false,
        paths: [{ name: "docs", path: "/docs" }],
        dbPath: "/tmp/test.db",
      },
      noBase,
    );
    expect(cfg.embed.model).toBe("BAAI/bge-large-zh-v1.5");
    expect(cfg.rerank?.model).toBe("BAAI/bge-reranker-v2-m3");
    expect(cfg.expand?.model).toBe("Qwen/Qwen3-8B");
    expect(cfg.searchLimit).toBe(8);
    expect(cfg.refreshIntervalMs).toBe(120_000);
    expect(cfg.includeOpenClawMemory).toBe(false);
    expect(cfg.extraPaths).toEqual([{ name: "docs", path: "/docs" }]);
    expect(cfg.dbPath).toBe("/tmp/test.db");
  });
});
