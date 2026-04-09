#!/usr/bin/env bun
/**
 * npm `bin` entry — npm rejects `.ts` in package.json `bin`; this shim delegates to the CLI source.
 */
import "../src/seekx.ts";
