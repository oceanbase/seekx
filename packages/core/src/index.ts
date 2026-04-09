// Public API for @seekx/core

export { openDatabase, loadSqliteVec } from "./db.ts";
export type { Database } from "./db.ts";
export { Store } from "./store.ts";
export type {
  RawResult,
  DocumentRow,
  CollectionRow,
  CollectionStats,
  ChunkRow,
  AddCollectionInput,
  IndexStatus,
} from "./store.ts";

export { SeekxClient, l2normalize } from "./client.ts";
export type { RerankResult, LLMCache } from "./client.ts";

export {
  loadConfig,
  requireConfig,
  writeConfigKey,
  setConfigKey,
  getConfigKey,
  isEmbedConfigured,
  writeConfig,
  dumpConfig,
} from "./config.ts";
export type { ResolvedConfig, RawConfig, ServiceEndpoint } from "./config.ts";

export { indexFile, indexDirectory } from "./indexer.ts";
export type {
  IndexFileResult,
  IndexFileStatus,
  IndexDirectoryResult,
  IndexProgressEvent,
  IndexProgressCallback,
} from "./indexer.ts";

export { hybridSearch } from "./search.ts";
export type { SearchOptions, SearchResult, SearchProgressEvent, SearchProgressCallback } from "./search.ts";

export { Watcher } from "./watcher.ts";
export type { WatcherEvent, WatchOptions, CollectionWatch } from "./watcher.ts";

export { chunkDocument } from "./chunker.ts";
export type { Chunk } from "./chunker.ts";

export { expandForFTS, buildFTSQuery } from "./tokenizer.ts";
