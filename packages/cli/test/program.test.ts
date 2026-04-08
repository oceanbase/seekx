import { describe, expect, test } from "bun:test";
import { createProgram } from "../src/program.ts";

async function renderHelp(args: string[]): Promise<string> {
  const program = createProgram();
  let output = "";

  program.configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: (text) => {
      output += text;
    },
  });
  program.exitOverride();

  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "commander.helpDisplayed"
    ) {
      return output;
    }
    throw error;
  }

  return output;
}

describe("createProgram", () => {
  test("registers the primary subcommands", () => {
    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toEqual(
      expect.arrayContaining([
        "onboard",
        "add",
        "collections",
        "remove",
        "reindex",
        "search",
        "vsearch",
        "query",
        "get",
        "watch",
        "status",
        "config",
        "mcp",
      ]),
    );
  });

  test("renders top-level help without module load failures", async () => {
    const help = await renderHelp(["--help"]);

    expect(help).toContain("Context search engine for AI agents and humans.");
    expect(help).toContain("seekx search");
    expect(help).toContain("seekx mcp");
  });

  test("renders subcommand help for mcp", async () => {
    const help = await renderHelp(["mcp", "--help"]);

    expect(help).toContain("Start MCP server for AI agent integration");
  });
});
