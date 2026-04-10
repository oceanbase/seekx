/**
 * CLI release version — single source of truth is packages/cli/package.json.
 */

import cliPackage from "../package.json" with { type: "json" };

export const CLI_VERSION: string = cliPackage.version;
