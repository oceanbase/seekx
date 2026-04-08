import { describe, expect, test } from "bun:test";
import { detectHomebrewSqlitePrefix, getDarwinSQLiteCandidates } from "../src/db.ts";

describe("SQLite runtime discovery", () => {
  test("detectHomebrewSqlitePrefix trims successful brew output", () => {
    const prefix = detectHomebrewSqlitePrefix((command, args) => {
      expect(command).toBe("brew");
      expect(args).toEqual(["--prefix", "sqlite"]);
      return { status: 0, stdout: "/custom/homebrew/opt/sqlite\n" };
    });

    expect(prefix).toBe("/custom/homebrew/opt/sqlite");
  });

  test("detectHomebrewSqlitePrefix returns null on failure", () => {
    const prefix = detectHomebrewSqlitePrefix(() => ({ status: 1, stdout: "" }));
    expect(prefix).toBeNull();
  });

  test("getDarwinSQLiteCandidates preserves priority and removes duplicates", () => {
    const candidates = getDarwinSQLiteCandidates(
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/opt/homebrew/opt/sqlite",
    );

    expect(candidates).toEqual([
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    ]);
  });

  test("getDarwinSQLiteCandidates includes brew-derived fallback", () => {
    const candidates = getDarwinSQLiteCandidates(undefined, "/custom/prefix");

    expect(candidates).toContain("/custom/prefix/lib/libsqlite3.dylib");
  });
});
