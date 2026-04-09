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
import { join } from "node:path";
import { SeekxClient, loadSqliteVec, openDatabase, writeConfigKey } from "seekx-core";
import type { Command } from "commander";
import { watchPid } from "../lock.ts";

const CONFIG_DIR = join(homedir(), ".seekx");
const CONFIG_PATH = join(CONFIG_DIR, "config.yml");
const DB_PATH = join(CONFIG_DIR, "index.sqlite");

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
// Command
// ---------------------------------------------------------------------------

export function registerOnboard(program: Command): void {
  program
    .command("onboard")
    .description("Interactive setup wizard")
    .action(async () => {
      const { input, select, confirm } = await import("@inquirer/prompts");

      console.log("\n\x1b[1mWelcome to seekx\x1b[0m");
      console.log(
        "  Local hybrid search for your files — full-text + semantic, no GPU required.\n",
      );

      // ---- 1. Check Bun version ----
      const bunVersion = process.versions.bun ?? "unknown";
      const bunOk = bunVersion !== "unknown";
      console.log(
        `  Bun runtime   ${bunOk ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  ${bunVersion}`,
      );

      // ---- 2. Check sqlite-vec ----
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

      const db = await openDatabase(DB_PATH);
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
        const cont = await confirm({ message: "Continue without vector search?" });
        if (!cont) {
          console.log("Setup cancelled. Install SQLite and re-run 'seekx onboard'.");
          process.exit(0);
        }
      }

      console.log();

      // ---- 3. Choose provider ----
      console.log(
        "  seekx uses an embedding API to understand the meaning of your files.",
      );
      console.log(
        "  Pick a provider below — most offer a free tier to get started.\n",
      );
      const providerKey = await select({
        message: "Choose a provider:",
        choices: Object.entries(PRESETS).map(([key, p]) => ({
          value: key,
          name: p.label,
        })),
      });

      const preset = PRESETS[providerKey];
      if (!preset) {
        throw new Error(`Unknown provider preset: ${providerKey}`);
      }
      const isCustom = providerKey === "custom";

      // ---- 4. Collect credentials ----
      let embedBaseUrl = preset.baseUrl;
      let embedApiKey = "";
      let embedModel = preset.embedModel;
      let rerankModel = preset.rerankModel ?? "";
      let expandModel = preset.expandModel ?? "";

      if (isCustom) {
        // Custom: full manual input
        embedBaseUrl = await input({
          message: "Embed API base URL:",
          default: "https://api.siliconflow.cn/v1",
        });
        embedApiKey = await input({
          message: "Embed API key (leave blank if not required):",
          default: "",
        });
        embedModel = await input({ message: "Embed model name:", default: "BAAI/bge-m3" });
      } else {
        if (preset.needsKey) {
          embedApiKey = await input({ message: `${preset.label.split(" ")[0]} API key:` });
        }

        // Offer model customization
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

      // For custom mode, optionally configure rerank and expand separately
      let rerankBaseUrl = isCustom ? "" : embedBaseUrl;
      let rerankApiKey = isCustom ? "" : embedApiKey;
      let expandBaseUrl = isCustom ? "" : embedBaseUrl;
      let expandApiKey = isCustom ? "" : embedApiKey;

      if (isCustom) {
        const wantRerank = await confirm({
          message: "Configure rerank API? (optional, improves result quality)",
        });
        if (wantRerank) {
          rerankBaseUrl = await input({
            message: "Rerank API base URL:",
            default: embedBaseUrl,
          });
          rerankApiKey = await input({ message: "Rerank API key:", default: embedApiKey });
          rerankModel = await input({
            message: "Rerank model:",
            default: "BAAI/bge-reranker-v2-m3",
          });
        }

        const wantExpand = await confirm({
          message: "Configure expand (LLM query rewriting)? (optional)",
        });
        if (wantExpand) {
          expandBaseUrl = await input({
            message: "Expand API base URL:",
            default: embedBaseUrl,
          });
          expandApiKey = await input({ message: "Expand API key:", default: embedApiKey });
          expandModel = await input({ message: "Expand model:", default: "Qwen/Qwen3-8B" });
        }
      }

      // ---- 5. Health check ----
      console.log("\nRunning health checks…");

      const rerankCfg =
        rerankModel && rerankBaseUrl
          ? { baseUrl: rerankBaseUrl, apiKey: rerankApiKey, model: rerankModel }
          : null;
      const expandCfg =
        expandModel && expandBaseUrl
          ? { baseUrl: expandBaseUrl, apiKey: expandApiKey, model: expandModel }
          : null;

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
        const cont = await confirm({
          message: "Embedding API check failed. Save config anyway?",
        });
        if (!cont) {
          console.log("Setup cancelled.");
          process.exit(0);
        }
      }

      // ---- 6. Write config ----
      if (!existsSync(CONFIG_PATH)) {
        writeFileSync(CONFIG_PATH, "# seekx configuration\n", "utf-8");
      }

      await writeConfigKey(CONFIG_PATH, "embed.base_url", embedBaseUrl);
      await writeConfigKey(CONFIG_PATH, "embed.api_key", embedApiKey);
      await writeConfigKey(CONFIG_PATH, "embed.model", embedModel);

      if (rerankCfg) {
        await writeConfigKey(CONFIG_PATH, "rerank.base_url", rerankCfg.baseUrl);
        await writeConfigKey(CONFIG_PATH, "rerank.api_key", rerankCfg.apiKey);
        await writeConfigKey(CONFIG_PATH, "rerank.model", rerankCfg.model);
      }
      if (expandCfg) {
        await writeConfigKey(CONFIG_PATH, "expand.base_url", expandCfg.baseUrl);
        await writeConfigKey(CONFIG_PATH, "expand.api_key", expandCfg.apiKey);
        await writeConfigKey(CONFIG_PATH, "expand.model", expandCfg.model);
      }

      console.log(`\n\x1b[32m✓\x1b[0m Config written to ${CONFIG_PATH}`);

      // ---- 7. Start watch daemon ----
      console.log();
      console.log(
        "  Real-time indexing: a background watcher monitors your collections and",
      );
      console.log(
        "  re-indexes any file the moment it changes — so search results are always",
      );
      console.log("  fresh without you having to run any command.");

      const startDaemon = await confirm({
        message: "Enable real-time indexing now? (runs silently in background)",
        default: true,
      });

      if (startDaemon) {
        const running = watchPid(DB_PATH);
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
    });
}
