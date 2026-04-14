import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ResolvedConfig, type ServiceEndpoint } from "seekx-core";

export interface ExtraPath {
  name: string;
  path: string;
  pattern?: string;
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
  };
}
