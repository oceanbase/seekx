/**
 * onboard.ts — seekx onboard
 *
 * Interactive setup wizard:
 *   1. Check Bun version.
 *   2. Check sqlite-vec availability (guide user to Homebrew SQLite on macOS).
 *   3. Select a provider preset or enter custom values.
 *   4. Live health check against configured APIs.
 *   5. Write config to ~/.seekx/config.yml.
 *   6. Optionally spawn seekx watch as a detached background daemon.
 *
 * Provider presets fill in base_url and default model names so users only
 * need to paste their API key. Custom mode retains the original manual flow.
 *
 * Non-interactive mode (--yes):
 *   All confirmations accept their safe defaults; required values (provider,
 *   API key) must be supplied via --provider / environment variables.
 *   Exit codes: 0 success, 1 user cancel, 2 missing required arg, 3 health fail.
 *
 * Watch daemon spawn strategy:
 *   Uses process.argv[0] (the running Bun binary) and process.argv[1] (the
 *   seekx entry script) so the child inherits the exact same runtime and
 *   installation path, regardless of whether seekx was invoked via a global
 *   install, npx, or a direct path. stdio is set to "ignore" and the child
 *   is unref()'d so onboard can exit without waiting for the watcher.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SeekxClient, loadSqliteVec, openDatabase, writeConfigKey } from "seekx-core";
import type { Command } from "commander";
import { watchPid } from "../lock.ts";

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

interface Preset {
  label: string;
  baseUrl: string;
  embedModel: string;
  rerankModel: string | null; // null = not supported
  expandModel: string | null; // null = not supported
  needsKey: boolean;
}

const PRESETS: Record<string, Preset> = {
  siliconflow: {
    label: "SiliconFlow  (推荐 · 国内 · 三项全有 · 免费额度大)",
    baseUrl: "https://api.siliconflow.cn/v1",
    embedModel: "BAAI/bge-m3",
    rerankModel: "BAAI/bge-reranker-v2-m3",
    expandModel: "Qwen/Qwen3-8B",
    needsKey: true,
  },
  zhipu: {
    label: "Zhipu AI     (智谱 · 国内 · 三项全有)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    embedModel: "embedding-3",
    rerankModel: "rerank-pro",
    expandModel: "glm-4-flash",
    needsKey: true,
  },
  jina: {
    label: "Jina AI      (海外 · embed+rerank · 1M tokens 免费)",
    baseUrl: "https://api.jina.ai/v1",
    embedModel: "jina-embeddings-v3",
    rerankModel: "jina-reranker-v2-base-multilingual",
    expandModel: null,
    needsKey: true,
  },
  openai: {
    label: "OpenAI       (海外 · embed+expand · 无 rerank)",
    baseUrl: "https://api.openai.com/v1",
    embedModel: "text-embedding-3-small",
    rerankModel: null,
    expandModel: "gpt-4o-mini",
    needsKey: true,
  },
  ollama: {
    label: "Ollama       (本地 · 无需 API Key · 需本机运行 Ollama)",
    baseUrl: "http://localhost:11434/v1",
    embedModel: "nomic-embed-text",
    rerankModel: null,
    expandModel: null,
    needsKey: false,
  },
  custom: {
    label: "Custom       (手动输入所有参数)",
    baseUrl: "",
    embedModel: "",
    rerankModel: null,
    expandModel: null,
    needsKey: true,
  },
};

// ---------------------------------------------------------------------------
// Non-interactive helpers
// ---------------------------------------------------------------------------

/** Thrown when --yes is used but a required input cannot be resolved. Exit code 2. */
class NonInteractiveError extends Error {
  readonly exitCode = 2;
}

/**
 * Resolves a string option with this priority:
 *   1. Environment variable (if envVar is given and non-empty).
 *   2. Interactive prompt (if yes=false).
 *   3. Default value (if yes=true and default is provided).
 *   4. Error (if yes=true and required=true and no default or env var).
 */
async function resolveInput(opts: {
  envVar?: string;
  prompt: () => Promise<string>;
  default?: string;
  required?: boolean;
  yes: boolean;
  label?: string;
}): Promise<string> {
  const envVal = opts.envVar ? process.env[opts.envVar] : undefined;
  if (envVal !== undefined && envVal !== "") return envVal;
  if (opts.yes) {
    if (opts.default !== undefined) return opts.default;
    if (opts.required) {
      const hint = opts.envVar ? ` (set ${opts.envVar})` : "";
      throw new NonInteractiveError(
        `${opts.label ?? opts.envVar ?? "Required value"} is required in non-interactive mode${hint}`,
      );
    }
    return "";
  }
  return opts.prompt();
}

/**
 * Resolves a boolean confirmation: returns the default in --yes mode,
 * otherwise shows the interactive prompt.
 */
async function resolveConfirm(opts: {
  prompt: () => Promise<boolean>;
  default: boolean;
  yes: boolean;
}): Promise<boolean> {
  if (opts.yes) return opts.default;
  return opts.prompt();
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface OnboardOptions {
  yes: boolean;
  provider?: string;
  skipHealthCheck: boolean;
  /** False when --no-watch is passed; Commander sets true by default. */
  watch: boolean;
}

type InquirerInput = (opts: { message: string; default?: string }) => Promise<string>;
type InquirerSelect = (opts: {
  message: string;
  choices: Array<{ value: string; name: string }>;
}) => Promise<string>;
type InquirerConfirm = (opts: { message: string; default?: boolean }) => Promise<boolean>;

export function registerOnboard(program: Command): void {
  program
    .command("onboard")
    .description("Interactive setup wizard")
    .option("-y, --yes", "Accept all defaults and skip confirmations (for CI/scripting)")
    .option(
      "--provider <key>",
      `Provider preset: ${Object.keys(PRESETS).join("|")} (or set SEEKX_PROVIDER)`,
    )
    .option("--skip-health-check", "Skip API health verification")
    .option("--no-watch", "Do not start the background watch daemon after setup")
    .action(async (opts: OnboardOptions) => {
      const { input, select, confirm } = await import("@inquirer/prompts");
      const yes = opts.yes ?? false;
      try {
        await runOnboard({ opts, yes, input, select, confirm });
      } catch (err) {
        if (err instanceof NonInteractiveError) {
          console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });
}

// Exported for unit testing without going through Commander.
export async function runOnboard(ctx: {
  opts: OnboardOptions;
  yes: boolean;
  input: InquirerInput;
  select: InquirerSelect;
  confirm: InquirerConfirm;
}): Promise<void> {
  const { opts, yes, input, select, confirm } = ctx;

  // Respect env var overrides so tests can redirect to temp directories.
  const configPath =
    process.env.SEEKX_CONFIG_PATH ?? join(homedir(), ".seekx", "config.yml");
  const dbPath =
    process.env.SEEKX_DB_PATH ?? join(homedir(), ".seekx", "index.sqlite");
  const configDir = dirname(configPath);

  console.log("\n\x1b[1mWelcome to seekx\x1b[0m");
  console.log(
    "  Local hybrid search for your files — full-text + semantic, no GPU required.\n",
  );
  if (yes) console.log("  Running in non-interactive mode (--yes).\n");

  // ---- 1. Check Bun version ----
  const bunVersion = process.versions.bun ?? "unknown";
  const bunOk = bunVersion !== "unknown";
  console.log(
    `  Bun runtime   ${bunOk ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  ${bunVersion}`,
  );

  // ---- 2. Check sqlite-vec ----
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const db = await openDatabase(dbPath);
  const vecLoaded = await loadSqliteVec(db);
  db.close();

  console.log(
    `  sqlite-vec    ${vecLoaded ? "\x1b[32m✓\x1b[0m" : "\x1b[33m?\x1b[0m"}  ${vecLoaded ? "loaded" : "not available"}`,
  );

  if (!vecLoaded && process.platform === "darwin") {
    console.log(`
  \x1b[33mVector search requires sqlite-vec, which needs a SQLite build with extension loading.\x1b[0m
  Run:
    brew install sqlite
  seekx will auto-detect standard Homebrew installs.
  If detection still fails, set:
    export SEEKX_SQLITE_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
`);
    const cont = await resolveConfirm({
      yes,
      default: true, // --yes auto-continues without vector search
      prompt: () => confirm({ message: "Continue without vector search?" }),
    });
    if (!cont) {
      console.log("Setup cancelled. Install SQLite and re-run 'seekx onboard'.");
      process.exit(1);
    }
    if (yes) console.log("  \x1b[33m⚠\x1b[0m  Continuing without vector search (--yes).");
  }

  console.log();

  // ---- 3. Choose provider ----
  const providerKey = await resolveProvider({ opts, yes, select });
  const preset = PRESETS[providerKey];
  if (!preset) throw new Error(`Unknown provider preset: ${providerKey}`);
  const isCustom = providerKey === "custom";

  // ---- 4. Collect credentials ----
  let embedBaseUrl = preset.baseUrl;
  let embedApiKey = "";
  let embedModel = preset.embedModel;
  let rerankModel = preset.rerankModel ?? "";
  let expandModel = preset.expandModel ?? "";

  if (isCustom) {
    embedBaseUrl = await resolveInput({
      yes,
      envVar: "SEEKX_BASE_URL",
      label: "Embed API base URL",
      required: true,
      prompt: () =>
        input({ message: "Embed API base URL:", default: "https://api.siliconflow.cn/v1" }),
    });
    embedApiKey = await resolveInput({
      yes,
      envVar: "SEEKX_API_KEY",
      required: false,
      default: "",
      prompt: () =>
        input({ message: "Embed API key (leave blank if not required):", default: "" }),
    });
    embedModel = await resolveInput({
      yes,
      envVar: "SEEKX_EMBED_MODEL",
      label: "Embed model name",
      required: true,
      prompt: () => input({ message: "Embed model name:", default: "BAAI/bge-m3" }),
    });
  } else {
    if (preset.needsKey) {
      embedApiKey = await resolveInput({
        yes,
        envVar: "SEEKX_API_KEY",
        label: "API key",
        required: true,
        prompt: () => input({ message: `${preset.label.split(" ")[0]} API key:` }),
      });
    }

    // Env vars can selectively override model names even for named presets.
    const envEmbed = process.env.SEEKX_EMBED_MODEL;
    const envRerank = process.env.SEEKX_RERANK_MODEL;
    const envExpand = process.env.SEEKX_EXPAND_MODEL;

    if (envEmbed || envRerank || envExpand) {
      if (envEmbed) embedModel = envEmbed;
      if (envRerank && preset.rerankModel !== null) rerankModel = envRerank;
      if (envExpand && preset.expandModel !== null) expandModel = envExpand;
    } else if (!yes) {
      const customize = await confirm({
        message: "Customize model names? (Press Enter to use defaults)",
        default: false,
      });
      if (customize) {
        embedModel = await input({ message: "Embed model:", default: preset.embedModel });
        if (preset.rerankModel) {
          rerankModel = await input({
            message: "Rerank model:",
            default: preset.rerankModel,
          });
        }
        if (preset.expandModel) {
          expandModel = await input({
            message: "Expand model:",
            default: preset.expandModel,
          });
        }
      }
    }
    // In --yes mode without env overrides, preset defaults are already set above.
  }

  // For custom mode, optionally configure rerank and expand with independent endpoints.
  let rerankBaseUrl = isCustom ? "" : embedBaseUrl;
  let rerankApiKey = isCustom ? "" : embedApiKey;
  let expandBaseUrl = isCustom ? "" : embedBaseUrl;
  let expandApiKey = isCustom ? "" : embedApiKey;

  if (isCustom) {
    // In --yes mode, enable rerank only if SEEKX_RERANK_MODEL is set.
    const rerankModelEnv = process.env.SEEKX_RERANK_MODEL;
    const wantRerank = rerankModelEnv
      ? true
      : await resolveConfirm({
          yes,
          default: false,
          prompt: () =>
            confirm({ message: "Configure rerank API? (optional, improves result quality)" }),
        });
    if (wantRerank) {
      rerankBaseUrl = await resolveInput({
        yes,
        envVar: "SEEKX_RERANK_BASE_URL",
        default: embedBaseUrl,
        prompt: () => input({ message: "Rerank API base URL:", default: embedBaseUrl }),
      });
      rerankApiKey = await resolveInput({
        yes,
        envVar: "SEEKX_RERANK_API_KEY",
        default: embedApiKey,
        prompt: () => input({ message: "Rerank API key:", default: embedApiKey }),
      });
      rerankModel = await resolveInput({
        yes,
        envVar: "SEEKX_RERANK_MODEL",
        default: "BAAI/bge-reranker-v2-m3",
        prompt: () =>
          input({ message: "Rerank model:", default: "BAAI/bge-reranker-v2-m3" }),
      });
    }

    // In --yes mode, enable expand only if SEEKX_EXPAND_MODEL is set.
    const expandModelEnv = process.env.SEEKX_EXPAND_MODEL;
    const wantExpand = expandModelEnv
      ? true
      : await resolveConfirm({
          yes,
          default: false,
          prompt: () =>
            confirm({ message: "Configure expand (LLM query rewriting)? (optional)" }),
        });
    if (wantExpand) {
      expandBaseUrl = await resolveInput({
        yes,
        envVar: "SEEKX_EXPAND_BASE_URL",
        default: embedBaseUrl,
        prompt: () => input({ message: "Expand API base URL:", default: embedBaseUrl }),
      });
      expandApiKey = await resolveInput({
        yes,
        envVar: "SEEKX_EXPAND_API_KEY",
        default: embedApiKey,
        prompt: () => input({ message: "Expand API key:", default: embedApiKey }),
      });
      expandModel = await resolveInput({
        yes,
        envVar: "SEEKX_EXPAND_MODEL",
        default: "Qwen/Qwen3-8B",
        prompt: () => input({ message: "Expand model:", default: "Qwen/Qwen3-8B" }),
      });
    }
  }

  // ---- 5. Health check ----
  const rerankCfg =
    rerankModel && rerankBaseUrl
      ? { baseUrl: rerankBaseUrl, apiKey: rerankApiKey, model: rerankModel }
      : null;
  const expandCfg =
    expandModel && expandBaseUrl
      ? { baseUrl: expandBaseUrl, apiKey: expandApiKey, model: expandModel }
      : null;

  if (opts.skipHealthCheck) {
    console.log("\n  \x1b[2mSkipping health check (--skip-health-check).\x1b[0m");
  } else {
    console.log("\nRunning health checks…");

    const client = new SeekxClient(
      { baseUrl: embedBaseUrl, apiKey: embedApiKey, model: embedModel },
      rerankCfg,
      expandCfg,
    );

    const health = await client.healthCheck();
    const ok = (b: boolean | null | undefined) =>
      b == null ? "\x1b[2m—\x1b[0m" : b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";

    console.log(
      `  Embeddings    ${ok(health.embed?.ok)}  ${health.embed?.latencyMs ?? "—"}ms${health.embed?.dim ? `  dim=${health.embed.dim}` : ""}`,
    );
    if (health.rerank != null)
      console.log(`  Reranker      ${ok(health.rerank.ok)}  ${health.rerank.latencyMs}ms`);
    if (health.expand != null)
      console.log(`  Query expand  ${ok(health.expand.ok)}  ${health.expand.latencyMs}ms`);

    if (!health.embed?.ok) {
      if (yes) {
        console.error("\x1b[31mError:\x1b[0m Embedding API health check failed. Aborting.");
        console.error("  Use --skip-health-check to bypass, or fix your API key/URL.");
        process.exit(3);
      }
      const cont = await confirm({
        message: "Embedding API check failed. Save config anyway?",
      });
      if (!cont) {
        console.log("Setup cancelled.");
        process.exit(1);
      }
    }
  }

  // ---- 6. Write config ----
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "# seekx configuration\n", "utf-8");
  }

  await writeConfigKey(configPath, "embed.base_url", embedBaseUrl);
  await writeConfigKey(configPath, "embed.api_key", embedApiKey);
  await writeConfigKey(configPath, "embed.model", embedModel);

  if (rerankCfg) {
    await writeConfigKey(configPath, "rerank.base_url", rerankCfg.baseUrl);
    await writeConfigKey(configPath, "rerank.api_key", rerankCfg.apiKey);
    await writeConfigKey(configPath, "rerank.model", rerankCfg.model);
  }
  if (expandCfg) {
    await writeConfigKey(configPath, "expand.base_url", expandCfg.baseUrl);
    await writeConfigKey(configPath, "expand.api_key", expandCfg.apiKey);
    await writeConfigKey(configPath, "expand.model", expandCfg.model);
  }

  console.log(`\n\x1b[32m✓\x1b[0m Config written to ${configPath}`);

  // ---- 7. Start watch daemon ----
  let startDaemon: boolean;
  if (!opts.watch) {
    // --no-watch was passed explicitly
    startDaemon = false;
  } else if (yes) {
    startDaemon = true;
  } else {
    console.log();
    console.log(
      "  Real-time indexing: a background watcher monitors your collections and",
    );
    console.log(
      "  re-indexes any file the moment it changes — so search results are always",
    );
    console.log("  fresh without you having to run any command.");
    startDaemon = await confirm({
      message: "Enable real-time indexing now? (runs silently in background)",
      default: true,
    });
  }

  if (startDaemon) {
    const running = watchPid(dbPath);
    if (running !== null) {
      console.log(`\n  Real-time indexer is already running (PID ${running}).`);
    } else {
      try {
        // SpawnOptions avoids the 'never' overload intersection; cast confirms
        // the result is ChildProcess. argv[0]/[1] are asserted non-null since
        // this code path only runs inside a real CLI invocation.
        const spawnOpts: SpawnOptions = { detached: true, stdio: "ignore" };
        // biome-ignore lint/style/noNonNullAssertion: present in any real CLI invocation
        const child = spawn(process.argv[0]!, [process.argv[1] ?? "", "watch"], spawnOpts) as unknown as ChildProcess;
        child.unref();
        console.log(`\n\x1b[32m✓\x1b[0m Real-time indexer started (PID ${child.pid ?? "unknown"}).`);
        console.log(
          "  File changes are detected and indexed automatically — search results stay fresh.",
        );
        console.log(
          `  To stop: kill ${child.pid ?? "<PID>"}   or   pkill -f 'seekx watch'`,
        );
      } catch (err) {
        console.log(
          `\n\x1b[33m⚠\x1b[0m Failed to start real-time indexer: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.log("  Start it manually later with: seekx watch");
      }
    }
  }

  console.log("\nNext steps:");
  if (startDaemon) {
    console.log("  seekx add <path>   — add a directory; the indexer picks it up automatically");
  } else {
    console.log("  seekx add <path>   — add a directory to index");
    console.log("  seekx watch        — start real-time watcher");
  }
  console.log("  seekx search <q>   — search your knowledge base");
  console.log();
}

async function resolveProvider(ctx: {
  opts: OnboardOptions;
  yes: boolean;
  select: InquirerSelect;
}): Promise<string> {
  const { opts, yes, select } = ctx;
  const providerKey = opts.provider ?? process.env.SEEKX_PROVIDER;

  if (providerKey) {
    if (!PRESETS[providerKey]) {
      const validKeys = Object.keys(PRESETS).join(", ");
      throw new NonInteractiveError(
        `Unknown provider '${providerKey}'. Valid options: ${validKeys}`,
      );
    }
    console.log(`  Provider      ${providerKey}`);
    return providerKey;
  }

  if (yes) {
    throw new NonInteractiveError(
      "Provider is required in non-interactive mode. Use --provider <key> or set SEEKX_PROVIDER.",
    );
  }

  console.log("  seekx uses an embedding API to understand the meaning of your files.");
  console.log("  Pick a provider below — most offer a free tier to get started.\n");
  return select({
    message: "Choose a provider:",
    choices: Object.entries(PRESETS).map(([key, p]) => ({
      value: key,
      name: p.label,
    })),
  });
}
