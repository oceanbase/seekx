import { describe, expect, test } from "bun:test";
import {
  detectHomebrewSqlitePrefix,
  getDarwinSQLiteCandidates,
  openDatabase,
} from "../src/db.ts";

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

  test("openDatabase lazily loads bun:sqlite and can open :memory:", async () => {
    const db = await openDatabase(":memory:");
    try {
      const row = db.query("SELECT 1 AS n").get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("parallel openDatabase calls share a single bun:sqlite load", async () => {
    const [a, b] = await Promise.all([openDatabase(":memory:"), openDatabase(":memory:")]);
    try {
      expect(a.query("SELECT 2 AS n").get() as { n: number }).toEqual({ n: 2 });
      expect(b.query("SELECT 3 AS n").get() as { n: number }).toEqual({ n: 3 });
    } finally {
      a.close();
      b.close();
    }
  });
});
