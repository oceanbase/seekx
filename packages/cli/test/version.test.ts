import { describe, expect, test } from "bun:test";
import cliPackage from "../package.json" with { type: "json" };
import { createProgram } from "../src/program.ts";

describe("CLI version", () => {
  test("--version matches package.json", async () => {
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
      await program.parseAsync(["--version"], { from: "user" });
    } catch (error) {
      expect(error).toMatchObject({ code: "commander.version" });
    }

    expect(output).toBe(cliPackage.version + "\n");
  });
});
