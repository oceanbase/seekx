import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePluginConfig, type RawPluginConfig } from "./config.ts";
import {
  buildAutoRecallSystemGuidance,
  inspectAutoRecallPrompt,
  runAutoRecall,
} from "./auto-recall.ts";
import { SeekxLifecycle } from "./lifecycle.ts";
import { buildSeekxMemoryPromptSection } from "./prompt.ts";
import { buildMemorySearchManager } from "./runtime.ts";

export default definePluginEntry({
  id: "seekx",
  name: "seekx",
  description: "Local-first hybrid search memory backend: BM25 + vector + rerank + CJK",
  kind: "memory",

  register(api) {
    const raw = (api.pluginConfig ?? {}) as RawPluginConfig;
    const config = resolvePluginConfig(raw);
    const lifecycle = new SeekxLifecycle(config);
    const { manager } = buildMemorySearchManager(lifecycle);
    const runtime = {
      getMemorySearchManager: () => ({ manager }),
      resolveMemoryBackendConfig: (rawCfg: unknown) =>
        resolvePluginConfig(rawCfg as RawPluginConfig),
    };

    // Start eagerly so the initial index is underway before the first
    // memory_search call arrives. start() is non-blocking; indexing runs
    // in the background.
    void lifecycle.start();

    api.registerMemoryCapability({
      promptBuilder: buildSeekxMemoryPromptSection,
      runtime,
    });

    api.logger.info("[seekx] before_prompt_build autoRecall hook registered");

    api.on("before_prompt_build", async (event, ctx) => {
      const decision = inspectAutoRecallPrompt(event.prompt, config.autoRecall, ctx.trigger);
      const promptPreview =
        decision.normalizedPrompt.length > 120
          ? `${decision.normalizedPrompt.slice(0, 117)}...`
          : decision.normalizedPrompt;

      if (ctx.trigger === "user") {
        api.logger.info(
          `[seekx] before_prompt_build trigger=${ctx.trigger} decision=${decision.shouldRun ? "run" : "skip"} reason=${decision.reason} prompt="${promptPreview}"`,
        );
      }

      if (!decision.shouldRun) {
        return;
      }

      try {
        const recall = await runAutoRecall({
          manager,
          prompt: decision.normalizedPrompt,
          config: config.autoRecall,
        });

        api.logger.info(
          `[seekx] autoRecall query="${recall.query}" considered=${recall.consideredResults} injected=${recall.injectedResults} topScore=${recall.topScore ?? "n/a"}`,
        );

        const prependSystemContext = buildAutoRecallSystemGuidance({
          query: recall.query,
          injectedResults: recall.injectedResults,
          topScore: recall.topScore,
        });

        return {
          prependSystemContext,
          ...(recall.injectedContext ? { prependContext: recall.injectedContext } : {}),
        };
      } catch (err) {
        api.logger.warn(`[seekx] autoRecall failed: ${String(err)}`);
      }
    });

    // Register a background service so OpenClaw calls stop() on shutdown,
    // giving the watcher and database a chance to close cleanly.
    // id is required by the real OpenClawPluginService type.
    api.registerService({
      id: "seekx-lifecycle",
      stop: () => lifecycle.stop(),
    } as Parameters<typeof api.registerService>[0]);
  },
});
