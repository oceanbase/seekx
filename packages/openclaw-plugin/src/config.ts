import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ResolvedConfig, type ServiceEndpoint } from "seekx-core";

export interface ExtraPath {
  name: string;
  path: string;
  pattern?: string;
}

export interface AutoRecallConfig {
  enabled: boolean;
  maxResults: number;
  minScore: number;
  maxChars: number;
  minQueryLength: number;
}

/** Raw shape of what OpenClaw puts in pluginConfig. */
export interface RawPluginConfig {
  dbPath?: string;
  paths?: unknown;
  apiKey?: string;
  baseUrl?: string;
  embedModel?: string;
  rerankModel?: string;
  expandModel?: string;
  searchLimit?: number;
  refreshIntervalMs?: number;
  includeOpenClawMemory?: boolean;
  autoRecall?: unknown;
  citations?: string;
  searchTimeoutMs?: number;
}

export interface SeekxPluginConfig {
  dbPath: string;
  extraPaths: ExtraPath[];
  embed: ServiceEndpoint;
  rerank: ServiceEndpoint | null;
  expand: ServiceEndpoint | null;
  searchLimit: number;
  refreshIntervalMs: number;
  includeOpenClawMemory: boolean;
  autoRecall: AutoRecallConfig;
  citations: "auto" | "on" | "off";
  searchTimeoutMs: number;
}

function normalizeExtraPaths(paths: unknown): ExtraPath[] {
  if (paths == null) return [];
  if (!Array.isArray(paths)) {
    throw new Error("Invalid plugin config: paths must be an array of { name, path, pattern? }");
  }

  return paths.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid plugin config: paths[${index}] must be an object`);
    }

    const { name, path, pattern } = entry as {
      name?: unknown;
      path?: unknown;
      pattern?: unknown;
    };

    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`Invalid plugin config: paths[${index}].name must be a non-empty string`);
    }
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error(`Invalid plugin config: paths[${index}].path must be a non-empty string`);
    }
    if (pattern != null && typeof pattern !== "string") {
      throw new Error(`Invalid plugin config: paths[${index}].pattern must be a string`);
    }

    return {
      name: name.trim(),
      path: path.trim(),
      ...(pattern ? { pattern } : {}),
    };
  });
}

function normalizeAutoRecall(input: unknown): AutoRecallConfig {
  const defaults: AutoRecallConfig = {
    enabled: true,
    maxResults: 3,
    minScore: 0.2,
    maxChars: 1200,
    minQueryLength: 4,
  };

  if (input == null) return defaults;
  if (typeof input !== "object") {
    throw new Error(
      "Invalid plugin config: autoRecall must be an object with { enabled?, maxResults?, minScore?, maxChars?, minQueryLength? }",
    );
  }

  const { enabled, maxResults, minScore, maxChars, minQueryLength } = input as {
    enabled?: unknown;
    maxResults?: unknown;
    minScore?: unknown;
    maxChars?: unknown;
    minQueryLength?: unknown;
  };

  if (enabled != null && typeof enabled !== "boolean") {
    throw new Error("Invalid plugin config: autoRecall.enabled must be a boolean");
  }
  if (
    maxResults != null &&
    (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1)
  ) {
    throw new Error("Invalid plugin config: autoRecall.maxResults must be a positive integer");
  }
  if (minScore != null && (typeof minScore !== "number" || minScore < 0 || minScore > 1)) {
    throw new Error("Invalid plugin config: autoRecall.minScore must be a number between 0 and 1");
  }
  if (
    maxChars != null &&
    (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < 1)
  ) {
    throw new Error("Invalid plugin config: autoRecall.maxChars must be a positive integer");
  }
  if (
    minQueryLength != null &&
    (typeof minQueryLength !== "number" ||
      !Number.isInteger(minQueryLength) ||
      minQueryLength < 1)
  ) {
    throw new Error(
      "Invalid plugin config: autoRecall.minQueryLength must be a positive integer",
    );
  }

  return {
    enabled: enabled ?? defaults.enabled,
    maxResults: typeof maxResults === "number" ? maxResults : defaults.maxResults,
    minScore: minScore ?? defaults.minScore,
    maxChars: typeof maxChars === "number" ? maxChars : defaults.maxChars,
    minQueryLength: typeof minQueryLength === "number" ? minQueryLength : defaults.minQueryLength,
  };
}

const VALID_CITATIONS = new Set(["auto", "on", "off"]);

function normalizeCitations(input: unknown): "auto" | "on" | "off" {
  if (input == null) return "auto";
  if (typeof input !== "string" || !VALID_CITATIONS.has(input)) {
    throw new Error(
      `Invalid plugin config: citations must be "auto", "on", or "off"`,
    );
  }
  return input as "auto" | "on" | "off";
}

function normalizeSearchTimeoutMs(input: unknown): number {
  if (input == null) return 8000;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(
      "Invalid plugin config: searchTimeoutMs must be a non-negative number",
    );
  }
  return input;
}

/**
 * Merge the OpenClaw plugin config with the seekx config file.
 *
 * Precedence (high → low):
 *   1. pluginConfig fields  (plugins.entries.seekx.config in openclaw.json)
 *   2. ~/.seekx/config.yml  (seekx's own config file)
 *   3. Built-in defaults
 *
 * @param raw - Raw plugin config from OpenClaw.
 * @param loadConfigFn - Injectable config loader; defaults to the real
 *   loadConfig() so production code needs no changes. Tests pass a stub.
 */
export function resolvePluginConfig(
  raw: RawPluginConfig,
  loadConfigFn: () => ResolvedConfig | null = loadConfig,
): SeekxPluginConfig {
  const base: ResolvedConfig | null = loadConfigFn();

  const baseUrl = raw.baseUrl ?? base?.embed.baseUrl ?? "";
  const apiKey = raw.apiKey ?? base?.embed.apiKey ?? "";
  const embedModel = raw.embedModel ?? base?.embed.model ?? "";
  const rerankModel = raw.rerankModel ?? base?.rerank?.model ?? null;
  const expandModel = raw.expandModel ?? base?.expand?.model ?? null;

  const embed: ServiceEndpoint = { baseUrl, apiKey, model: embedModel };

  // For rerank and expand, if plugin config specifies a model name, build the
  // endpoint using the same baseUrl/apiKey (they share the same provider).
  // Otherwise fall back to the full endpoint from ~/.seekx/config.yml.
  const rerank: ServiceEndpoint | null = rerankModel
    ? { baseUrl, apiKey, model: rerankModel }
    : (base?.rerank ?? null);

  const expand: ServiceEndpoint | null = expandModel
    ? { baseUrl, apiKey, model: expandModel }
    : (base?.expand ?? null);

  return {
    dbPath: raw.dbPath ?? join(homedir(), ".seekx", "openclaw.db"),
    extraPaths: normalizeExtraPaths(raw.paths),
    embed,
    rerank,
    expand,
    searchLimit: raw.searchLimit ?? 6,
    refreshIntervalMs: raw.refreshIntervalMs ?? 300_000,
    includeOpenClawMemory: raw.includeOpenClawMemory ?? true,
    autoRecall: normalizeAutoRecall(raw.autoRecall),
    citations: normalizeCitations(raw.citations),
    searchTimeoutMs: normalizeSearchTimeoutMs(raw.searchTimeoutMs),
  };
}
