/**
 * config.ts — Configuration loading and resolution.
 *
 * Config file: ~/.seekx/config.yml (or SEEKX_CONFIG_PATH env var override).
 *
 * Resolution priority (high → low):
 *   1. Environment variables (SEEKX_API_KEY, SEEKX_BASE_URL, SEEKX_SQLITE_PATH)
 *   2. Per-service config (embed.*, rerank.*, expand.*)
 *   3. Top-level provider.* (inherited by all services)
 *   4. Built-in defaults
 *
 * Callers receive a fully-resolved ResolvedConfig; they never read YAML directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// YAML schema types
// ---------------------------------------------------------------------------

interface ProviderConfig {
  base_url?: string;
  api_key?: string;
  embed_model?: string;
  rerank_model?: string;
  expand_model?: string;
}

interface ServiceConfig {
  base_url?: string;
  api_key?: string;
  model?: string;
}

interface SearchConfig {
  default_limit?: number;
  rerank?: boolean;
  min_score?: number;
}

interface WatchConfig {
  debounce_ms?: number;
  ignore?: string[];
}

export interface RawConfig {
  provider?: ProviderConfig;
  embed?: ServiceConfig;
  rerank?: ServiceConfig;
  expand?: ServiceConfig;
  search?: SearchConfig;
  watch?: WatchConfig;
}

// ---------------------------------------------------------------------------
// Resolved types (what callers use)
// ---------------------------------------------------------------------------

export interface ServiceEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ResolvedConfig {
  embed: ServiceEndpoint;
  rerank: ServiceEndpoint | null; // null = not configured
  expand: ServiceEndpoint | null; // null = not configured
  search: {
    defaultLimit: number;
    rerank: boolean;
    minScore: number;
  };
  watch: {
    debounceMs: number;
    ignore: string[];
  };
  dbPath: string;
  configPath: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DEFAULT_IGNORE = ["node_modules", ".git", "*.tmp", ".DS_Store"];

function getConfigPath(): string {
  return process.env.SEEKX_CONFIG_PATH ?? join(homedir(), ".seekx", "config.yml");
}

function getDbPath(): string {
  return process.env.SEEKX_DB_PATH ?? join(homedir(), ".seekx", "index.sqlite");
}

// ---------------------------------------------------------------------------
// Load and resolve
// ---------------------------------------------------------------------------

/** Load and fully resolve the configuration. Returns null if config file is missing. */
export function loadConfig(): ResolvedConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;

  let raw: RawConfig = {};
  try {
    const text = readFileSync(configPath, "utf-8");
    raw = (YAML.parse(text) as RawConfig | null) ?? {};
  } catch (e) {
    throw new Error(`Failed to parse ${configPath}: ${e}`);
  }

  return resolveConfig(raw, configPath);
}

/**
 * Load config, throwing a user-friendly error if missing.
 * Use this in CLI commands that require a configured provider.
 */
export function requireConfig(): ResolvedConfig {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error("Config not found. Run 'seekx onboard' to set up seekx.");
  }
  return cfg;
}

function resolveConfig(raw: RawConfig, configPath: string): ResolvedConfig {
  const p = raw.provider ?? {};
  const envKey = process.env.SEEKX_API_KEY;
  const envBase = process.env.SEEKX_BASE_URL;

  function resolveService(
    svc: ServiceConfig | undefined,
    modelKey: "embed_model" | "rerank_model" | "expand_model",
  ): ServiceEndpoint | null {
    const baseUrl = svc?.base_url ?? envBase ?? p.base_url ?? "";
    const apiKey = envKey ?? svc?.api_key ?? p.api_key ?? "";
    const model = svc?.model ?? p[modelKey] ?? "";

    if (!baseUrl || !apiKey || !model) return null;
    return { baseUrl, apiKey, model };
  }

  const embed = resolveService(raw.embed, "embed_model");
  const rerank = resolveService(raw.rerank, "rerank_model");
  const expand = resolveService(raw.expand, "expand_model");

  return {
    embed: embed ?? { baseUrl: "", apiKey: "", model: "" }, // always present, may be empty
    rerank,
    expand,
    search: {
      defaultLimit: raw.search?.default_limit ?? 10,
      rerank: raw.search?.rerank ?? true,
      minScore: raw.search?.min_score ?? 0.3,
    },
    watch: {
      debounceMs: raw.watch?.debounce_ms ?? 500,
      ignore: raw.watch?.ignore ?? DEFAULT_IGNORE,
    },
    dbPath: getDbPath(),
    configPath,
  };
}

/** Check whether the embed endpoint is fully configured. */
/** Returns true if enough embed config is present to attempt API calls. */
export function isEmbedConfigured(cfg: ResolvedConfig): boolean {
  return Boolean(cfg.embed.baseUrl && cfg.embed.model);
}

// ---------------------------------------------------------------------------
// Write config
// ---------------------------------------------------------------------------

export interface WriteConfigInput {
  providerBaseUrl: string;
  providerApiKey: string;
  embedModel: string;
  rerankModel?: string;
  expandModel?: string;
}

export function writeConfig(input: WriteConfigInput): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const raw: RawConfig = {
    provider: {
      base_url: input.providerBaseUrl,
      api_key: input.providerApiKey,
      embed_model: input.embedModel,
      ...(input.rerankModel ? { rerank_model: input.rerankModel } : {}),
      ...(input.expandModel ? { expand_model: input.expandModel } : {}),
    },
    search: { default_limit: 10, rerank: true, min_score: 0.3 },
    watch: { debounce_ms: 500, ignore: DEFAULT_IGNORE },
  };

  const yaml = YAML.stringify(raw, { indent: 2, lineWidth: 0 });
  writeFileSync(configPath, yaml, "utf-8");
}

/** Set a single dotted key in the YAML config (e.g. "provider.embed_model"). */
export function setConfigKey(dotKey: string, value: string): void {
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = (YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) ?? {};
    } catch {
      // start fresh
    }
  }

  const keys = dotKey.split(".");
  let node = raw as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  const leafKey = keys.at(-1);
  if (!leafKey) return;
  node[leafKey] = value;

  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, YAML.stringify(raw, { indent: 2, lineWidth: 0 }), "utf-8");
}

/** Get a single dotted key from the YAML config. Returns null if not set. */
export function getConfigKey(dotKey: string): string | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;

  let raw: Record<string, unknown> = {};
  try {
    raw = (YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }

  const keys = dotKey.split(".");
  let node: unknown = raw;
  for (const k of keys) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[k];
  }
  return node == null ? null : String(node);
}

/** Return the raw YAML string of the entire config, or null if missing. */
export function dumpConfig(): string | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  return readFileSync(configPath, "utf-8");
}

/**
 * Write a single dotted key to a specific config file path.
 * Convenience wrapper over setConfigKey for use by the onboard wizard.
 */
export async function writeConfigKey(
  configPath: string,
  dotKey: string,
  value: string,
): Promise<void> {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = (YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) ?? {};
    } catch {
      // start fresh
    }
  }
  const keys = dotKey.split(".");
  let node = raw as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  const leafKey = keys.at(-1);
  if (!leafKey) return;
  node[leafKey] = value;

  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, YAML.stringify(raw, { indent: 2, lineWidth: 0 }), "utf-8");
}
