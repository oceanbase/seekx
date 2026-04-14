/**
 * Type stubs for the OpenClaw plugin SDK.
 *
 * These declarations cover the narrow surface used by this plugin.
 * The actual types are provided at runtime by the installed openclaw package.
 * Generated from docs.openclaw.ai/plugins/sdk-overview (2026-04).
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface MemorySearchResult {
    path: string;
    content: string;
    score: number;
    collection?: string;
    title?: string | null;
  }

  export interface MemorySearchOpts {
    limit?: number;
    collection?: string;
    /** Citations mode passed through from OpenClaw's memory.citations setting. */
    citations?: "auto" | "on" | "off";
  }

  /**
   * Subset of MemoryProviderStatus returned by the real OpenClaw SDK.
   * `status()` is called synchronously by OpenClaw's status scanner.
   */
  export interface BackendStatus {
    backend: string;
    provider?: string;
    dbPath?: string;
    /** Document (file) count — maps to MemoryProviderStatus.files. */
    files?: number;
    chunks?: number;
    /** Legacy alias kept for backward compat with older test assertions. */
    documents?: number;
    embeddedChunks?: number;
    vectorSearchAvailable?: boolean;
    embedModel?: string | null;
    collections?: Array<{ name: string; path: string; docCount: number }>;
    vector?: { enabled: boolean; available?: boolean };
    custom?: Record<string, unknown>;
  }

  /**
   * The interface OpenClaw calls when memory_search / memory_get fire.
   * Inferred from Honcho plugin source and openclaw/plugin-sdk/memory-host-search.
   */
  export interface MemorySearchManager {
    search(query: string, opts: MemorySearchOpts): Promise<MemorySearchResult[]>;
    readFile(path: string): Promise<string>;
    /** Synchronous — called without await by OpenClaw's status scanner. */
    status(): BackendStatus;
    probeEmbeddingAvailability(): Promise<boolean>;
    probeVectorAvailability(): Promise<boolean>;
  }

  /**
   * Shape passed to api.registerMemoryRuntime().
   * Legacy-compatible API; registerMemoryCapability() is preferred
   * but its interface is not yet publicly documented (2026-04).
   */
  export interface MemoryRuntimeRegistration {
    getMemorySearchManager(): { manager: MemorySearchManager };
    resolveMemoryBackendConfig(raw: unknown): unknown;
  }

  export type MemoryPromptSectionBuilder = (params: {
    availableTools: Set<string>;
    citationsMode?: string;
  }) => string[];

  export interface MemoryPluginCapability {
    promptBuilder?: MemoryPromptSectionBuilder;
    runtime?: MemoryRuntimeRegistration;
  }

  export interface PluginHookAgentContext {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    trigger?: string;
  }

  export interface PluginHookBeforePromptBuildEvent {
    prompt: string;
    messages: unknown[];
  }

  export interface PluginHookBeforePromptBuildResult {
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
  }

  export interface PluginHookHandlerMap {
    before_prompt_build: (
      event: PluginHookBeforePromptBuildEvent,
      ctx: PluginHookAgentContext,
    ) =>
      | Promise<PluginHookBeforePromptBuildResult | void>
      | PluginHookBeforePromptBuildResult
      | void;
  }

  export interface PluginServiceContext {}

  export interface PluginService {
    /** Unique service identifier required by OpenClaw's service registry. */
    id: string;
    start?: (ctx: PluginServiceContext) => Promise<void> | void;
    stop?: (ctx: PluginServiceContext) => Promise<void> | void;
  }

  export interface PluginLogger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  }

  export interface OpenClawPluginApi {
    /** Plugin id as declared in openclaw.plugin.json. */
    id: string;
    /** Plugin-specific config from plugins.entries.<id>.config. */
    pluginConfig: Record<string, unknown>;
    /** Scoped logger. */
    logger: PluginLogger;

    /**
     * Register a memory runtime adapter (legacy-compatible exclusive slot).
     * Sets this plugin as the active memory backend.
     */
    registerMemoryRuntime(registration: MemoryRuntimeRegistration): void;

    /**
     * Preferred unified memory capability registration.
     * Allows a memory plugin to expose both prompt guidance and runtime.
     */
    registerMemoryCapability(capability: MemoryPluginCapability): void;

    /**
     * Register a lifecycle hook handler.
     */
    on<K extends keyof PluginHookHandlerMap>(
      hookName: K,
      handler: PluginHookHandlerMap[K],
      opts?: { priority?: number },
    ): void;

    /**
     * Register a long-lived background service.
     * stop() is called on gateway shutdown, giving the service a chance
     * to flush and close resources.
     */
    registerService(service: PluginService): void;
  }

  export interface DefinePluginEntryOptions {
    /** Must match the id in openclaw.plugin.json. */
    id: string;
    name: string;
    description: string;
    /** Set to "memory" to participate in plugins.slots.memory. */
    kind?: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(opts: DefinePluginEntryOptions): unknown;
}
