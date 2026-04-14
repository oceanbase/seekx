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

  test("autoRecall defaults are enabled and conservative", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.autoRecall).toEqual({
      enabled: true,
      maxResults: 3,
      minScore: 0.2,
      maxChars: 1200,
      minQueryLength: 4,
    });
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

  test("citations defaults to 'auto'", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.citations).toBe("auto");
  });

  test("searchTimeoutMs defaults to 8000", () => {
    const cfg = resolvePluginConfig({}, noBase);
    expect(cfg.searchTimeoutMs).toBe(8000);
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

  test("plugin citations overrides default", () => {
    const cfg = resolvePluginConfig({ citations: "off" }, noBase);
    expect(cfg.citations).toBe("off");
  });

  test("plugin citations='on' is accepted", () => {
    const cfg = resolvePluginConfig({ citations: "on" }, noBase);
    expect(cfg.citations).toBe("on");
  });

  test("invalid citations value fails fast", () => {
    expect(() => resolvePluginConfig({ citations: "always" }, noBase)).toThrow(
      'Invalid plugin config: citations must be "auto", "on", or "off"',
    );
  });

  test("plugin searchTimeoutMs overrides default", () => {
    const cfg = resolvePluginConfig({ searchTimeoutMs: 15000 }, noBase);
    expect(cfg.searchTimeoutMs).toBe(15000);
  });

  test("searchTimeoutMs=0 disables timeout", () => {
    const cfg = resolvePluginConfig({ searchTimeoutMs: 0 }, noBase);
    expect(cfg.searchTimeoutMs).toBe(0);
  });

  test("invalid searchTimeoutMs fails fast", () => {
    expect(() => resolvePluginConfig({ searchTimeoutMs: -1 }, noBase)).toThrow(
      "Invalid plugin config: searchTimeoutMs must be a non-negative number",
    );
  });

  test("plugin autoRecall config overrides defaults", () => {
    const cfg = resolvePluginConfig(
      {
        autoRecall: {
          enabled: false,
          maxResults: 5,
          minScore: 0.35,
          maxChars: 800,
          minQueryLength: 8,
        },
      },
      noBase,
    );
    expect(cfg.autoRecall).toEqual({
      enabled: false,
      maxResults: 5,
      minScore: 0.35,
      maxChars: 800,
      minQueryLength: 8,
    });
  });

  test("plugin paths are preserved", () => {
    const paths = [{ name: "notes", path: "~/notes" }];
    const cfg = resolvePluginConfig({ paths }, noBase);
    expect(cfg.extraPaths).toEqual(paths);
  });

  test("invalid path entries fail fast with a clear error", () => {
    expect(() => resolvePluginConfig({ paths: ["~/notes"] }, noBase)).toThrow(
      "Invalid plugin config: paths[0] must be an object",
    );
  });

  test("path entries require name and path strings", () => {
    expect(() => resolvePluginConfig({ paths: [{ name: "", path: "/notes" }] }, noBase)).toThrow(
      "Invalid plugin config: paths[0].name must be a non-empty string",
    );
    expect(() => resolvePluginConfig({ paths: [{ name: "notes" }] }, noBase)).toThrow(
      "Invalid plugin config: paths[0].path must be a non-empty string",
    );
  });

  test("autoRecall validation fails fast with clear errors", () => {
    expect(() => resolvePluginConfig({ autoRecall: true }, noBase)).toThrow(
      "Invalid plugin config: autoRecall must be an object",
    );
    expect(() => resolvePluginConfig({ autoRecall: { enabled: "yes" } }, noBase)).toThrow(
      "Invalid plugin config: autoRecall.enabled must be a boolean",
    );
    expect(() => resolvePluginConfig({ autoRecall: { minScore: 2 } }, noBase)).toThrow(
      "Invalid plugin config: autoRecall.minScore must be a number between 0 and 1",
    );
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
        autoRecall: { enabled: false, maxResults: 2, minScore: 0.4, maxChars: 600 },
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
    expect(cfg.autoRecall.enabled).toBe(false);
    expect(cfg.autoRecall.maxResults).toBe(2);
    expect(cfg.autoRecall.minScore).toBe(0.4);
    expect(cfg.autoRecall.maxChars).toBe(600);
    expect(cfg.extraPaths).toEqual([{ name: "docs", path: "/docs" }]);
    expect(cfg.dbPath).toBe("/tmp/test.db");
  });
});
