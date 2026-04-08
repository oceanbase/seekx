/**
 * store.test.ts — Unit tests for Store using an in-memory SQLite database.
 *
 * We can't use bun:sqlite directly (dynamic import in db.ts), so we let
 * Store accept a Database-like interface and use the real db.ts openDatabase.
 * Tests run without sqlite-vec (vecLoaded = false).
 */
export {};
//# sourceMappingURL=store.test.d.ts.map