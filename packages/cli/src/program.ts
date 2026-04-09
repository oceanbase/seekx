/**
 * program.ts — builds the seekx CLI command tree.
 */

import { Command } from "commander";
import { registerAdd } from "./commands/add.ts";
import { registerCollections } from "./commands/collections.ts";
import { registerConfig } from "./commands/config.ts";
import { registerGet } from "./commands/get.ts";
import { registerMcp } from "./commands/mcp.ts";
import { registerOnboard } from "./commands/onboard.ts";
import { registerQuery } from "./commands/query.ts";
import { registerReindex } from "./commands/reindex.ts";
import { registerRemove } from "./commands/remove.ts";
import { registerSearch } from "./commands/search.ts";
import { registerStatus } from "./commands/status.ts";
import { registerVsearch } from "./commands/vsearch.ts";
import { registerWatch } from "./commands/watch.ts";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("seekx")
    .description(
      "Context search engine for AI agents and humans.\n" +
        "Your files are the truth, seekx is just the index.\n" +
        "No GPU. Hybrid Search. Realtime Index.",
    )
    .version("0.1.0")
    .option("--json", "Machine-readable JSON output (propagated to subcommands)")
    .addHelpText(
      "after",
      `
Examples:
  seekx onboard                   Interactive setup wizard
  seekx add ~/notes               Index a directory
  seekx add ~/docs --name docs    Index with a custom collection name
  seekx collections               List all collections
  seekx search "vector database"  Full-text + semantic search
  seekx vsearch "embedding"       Pure semantic search
  seekx query "how does X work"   Search with query expansion
  seekx get <docid>               Retrieve a document by id
  seekx watch                     Start real-time file watcher
  seekx status                    Show index stats and health
  seekx config                    View current configuration
  seekx mcp                       Start MCP server for AI agents
`,
    );

  registerOnboard(program);
  registerAdd(program);
  registerCollections(program);
  registerRemove(program);
  registerReindex(program);
  registerSearch(program);
  registerVsearch(program);
  registerQuery(program);
  registerGet(program);
  registerWatch(program);
  registerStatus(program);
  registerConfig(program);
  registerMcp(program);

  return program;
}
