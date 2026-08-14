#!/usr/bin/env node
/**
 * Node entry point of the `caesar` binary (`package.json`, `"bin": { "caesar":
 * "./dist/bin.js" }`): it only delegates to `runCli` (`./program.js`) and
 * translates its result into `process.exitCode`, behind a self-invocation
 * guard — see `isMain` below.
 *
 * All the commander wiring lives in `./program.js`, deliberately separated
 * from this file (see its header for the precise reason, task 12): this
 * file must never be imported by another entry point — its `isMain` guard
 * assumes `import.meta.url` stays unique to this module, an assumption true
 * under Node but false in a binary compiled by Bun (`bun-entry.ts`, which
 * imports `runCli` from `./program.js` directly, never from this file).
 */
import { fileURLToPath } from "node:url";
import { runCli } from "./program.js";

export { buildProgram, runCli } from "./program.js";

// Direct-execution threshold: this module behaves as a library when it is
// imported (by the tests, notably), and as an executable only when it is
// launched as such.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const code = await runCli(process.argv);
  process.exitCode = code;
}
