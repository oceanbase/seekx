import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePluginConfig, type RawPluginConfig } from "./config.ts";
import { SeekxLifecycle } from "./lifecycle.ts";
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

    // Start eagerly so the initial index is underway before the first
    // memory_search call arrives. start() is non-blocking; indexing runs
    // in the background.
    void lifecycle.start();

    api.registerMemoryRuntime({
      getMemorySearchManager: () => buildMemorySearchManager(lifecycle),
      resolveMemoryBackendConfig: (rawCfg: unknown) =>
        resolvePluginConfig(rawCfg as RawPluginConfig),
    });

    // Register a background service so OpenClaw calls stop() on shutdown,
    // giving the watcher and database a chance to close cleanly.
    api.registerService({
      stop: () => lifecycle.stop(),
    });
  },
});
