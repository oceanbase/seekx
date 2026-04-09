#!/usr/bin/env bun
/**
 * seekx — context search engine CLI entry point.
 */

import { createProgram } from "./program.ts";

const program = createProgram();

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(4);
});
