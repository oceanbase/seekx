/**
 * onboard.ts — seekx onboard
 *
 * Interactive setup wizard:
 *   1. Check Bun version.
 *   2. Check sqlite-vec availability (guide user to Homebrew SQLite on macOS).
 *   3. Select a provider preset or enter custom values.
 *   4. Live health check against configured APIs.
 *   5. Write config to ~/.seekx/config.yml.
 *
 * Provider presets fill in base_url and default model names so users only
 * need to paste their API key. Custom mode retains the original manual flow.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SeekxClient, loadSqliteVec, openDatabase, writeConfigKey } from "@seekx/core";
import type { Command } from "commander";

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

      console.log("\n\x1b[1mWelcome to seekx setup\x1b[0m\n");

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
        `  embed   ${ok(health.embed?.ok)}  ${health.embed?.latencyMs ?? "—"}ms${health.embed?.dim ? `  dim=${health.embed.dim}` : ""}`,
      );
      if (health.rerank != null)
        console.log(`  rerank  ${ok(health.rerank.ok)}  ${health.rerank.latencyMs}ms`);
      if (health.expand != null)
        console.log(`  expand  ${ok(health.expand.ok)}  ${health.expand.latencyMs}ms`);

      if (!health.embed?.ok) {
        const cont = await confirm({ message: "Embed API check failed. Save config anyway?" });
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
      console.log("\nNext steps:");
      console.log("  seekx add <path>   — add a directory to index");
      console.log("  seekx search <q>   — search your knowledge base");
      console.log("  seekx watch        — start real-time watcher\n");
    });
}
