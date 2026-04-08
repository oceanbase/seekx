/**
 * config.ts — seekx config [key] [value]
 *
 * Reads or writes a single config key in ~/.seekx/config.yml.
 *
 * Usage:
 *   seekx config                    — print entire config (redacted)
 *   seekx config embed.base_url     — print value of a key
 *   seekx config embed.api_key sk-x — set a key
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, writeConfigKey } from "@seekx/core";
import type { Command } from "commander";
import { EXIT, die, resolveJson } from "../utils.ts";

const DEFAULT_CONFIG_PATH = join(homedir(), ".seekx", "config.yml");

function getConfigPath(): string {
  return process.env.SEEKX_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

export function registerConfig(program: Command): void {
  program
    .command("config [key] [value]")
    .description("Read or write a config key (path: ~/.seekx/config.yml)")
    .option("--json", "Machine-readable output")
    .action(
      async (
        key: string | undefined,
        value: string | undefined,
        opts: { json?: boolean },
        command: Command,
      ) => {
        const json = resolveJson(opts, command);
        const configPath = getConfigPath();

        // "Set" mode: config file need not exist (will be created).
        if (key !== undefined && value !== undefined) {
          if (!existsSync(configPath)) {
            const dir = dirname(configPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(configPath, "# seekx configuration\n", "utf-8");
          }
          try {
            await writeConfigKey(configPath, key, value);
            const display = key.toLowerCase().includes("key") ? "***" : value;
            if (json) {
              console.log(JSON.stringify({ ok: true, key, value: display }));
            } else {
              console.log(`Set ${key} = ${display}`);
            }
          } catch (e) {
            die(`Failed to write config: ${e}`, EXIT.INTERNAL_ERROR, json);
          }
          return;
        }

        // "Get" and "Print" modes require config to exist.
        let cfg: ReturnType<typeof loadConfig>;
        try {
          cfg = loadConfig();
        } catch (e) {
          die(`Failed to load config: ${e}`, EXIT.INTERNAL_ERROR, json);
        }

        if (!cfg) {
          die("Config not found. Run 'seekx onboard' to set up seekx.", EXIT.USER_ERROR, json);
        }

        const resolved = cfg;

        // Print full config (redacted).
        if (!key) {
          const safe = redact(resolved as unknown as object);
          if (json) {
            console.log(JSON.stringify(safe, null, 2));
          } else {
            for (const [k, v] of Object.entries(flat(safe))) {
              console.log(`${k} = ${v}`);
            }
          }
          return;
        }

        // Get a single key.
        const v = getNestedKey(resolved as unknown as object, key);
        if (v === undefined) {
          die(`Unknown config key: ${key}`, EXIT.USER_ERROR, json);
        }
        if (json) {
          console.log(JSON.stringify({ [key]: v }));
        } else {
          console.log(String(v));
        }
      },
    );
}

function redact(cfg: object): object {
  const str = JSON.stringify(cfg);
  return JSON.parse(str.replace(/(api_?key[":\s]+")[^"]{4,}(")/gi, "$1***$2")) as object;
}

function flat(obj: object, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(result, flat(v as object, key));
    } else {
      result[key] = v;
    }
  }
  return result;
}

function getNestedKey(obj: object, dotPath: string): unknown {
  return dotPath.split(".").reduce((cur: unknown, k) => {
    if (cur !== null && typeof cur === "object") return (cur as Record<string, unknown>)[k];
    return undefined;
  }, obj as unknown);
}
