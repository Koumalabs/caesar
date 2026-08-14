#!/usr/bin/env bun
/**
 * Entry point of the standalone `caesar` binary (task 12, `bun build
 * --compile`): the only file of this package that Bun bundles — see
 * `scripts/build-binary.sh` at the repository root.
 *
 * Two roles:
 *
 * 1. Import `@caesar/tui` **statically** (`runTui`, below): this import is
 *    what makes the bundler embed it into the final binary, along with
 *    OpenTUI and its native core — no more need for Bun installed separately
 *    on the target machine, it is inside.
 * 2. Reconfigure, before launching the CLI, the two extension points that
 *    `@caesar/core` and `caesar config` expose to stop resolving
 *    `node_modules` paths — absent in a compiled binary
 *    (`createRequire(...).resolve()` has nothing left to resolve):
 *      - `configureChannelLauncher` (`@caesar/core`): the return channel
 *        self-invokes (`caesar channel serve --task-dir <dir>`) rather than
 *        looking for `@caesar/mcp-channel/dist/bin.js`.
 *      - `configureInProcessTui` (`./commands/config.js`): `caesar config`
 *        mounts the TUI directly in this process rather than spawning an
 *        external `bun`.
 *
 * The Node path (`bin.ts`) never calls these two functions: its default
 * behavior (module resolution for the channel, external Bun subprocess for
 * `caesar config`) stays unchanged — that is the day-to-day development path
 * in the monorepo, and it keeps working identically.
 *
 * `runCli` is imported from `./program.js`, **never** from `./bin.js`:
 * `bin.ts` carries its own self-invocation guard (`isMain`), designed for
 * Node, where each module keeps a distinct `import.meta.url`. In an
 * executable compiled by Bun, `import.meta.url` is the same virtual URL for
 * every module of the bundle — importing `bin.ts` here would therefore run
 * its guard a second time (observed by checking the real binary:
 * `caesar --version` answered twice in a row). See the header of
 * `program.ts` for the details of that discovery and of the separation it
 * motivated.
 *
 * Excluded from `packages/cli/tsconfig.json` (see its `exclude`): `tsc`
 * never processes this file, only `bun build --compile` reads it.
 */
import { CHANNEL_SERVER_NAME, configureChannelLauncher } from "@caesar/core";
import { runTui } from "@caesar/tui";
import { configureInProcessTui } from "./commands/config.js";
import { EXIT_OK } from "./output.js";
import { runCli } from "./program.js";

configureInProcessTui(async (root) => {
  await runTui(root);
  return EXIT_OK;
});

configureChannelLauncher((taskDir) => ({
  transport: "mcp-stdio",
  command: process.execPath,
  args: ["channel", "serve", "--task-dir", taskDir],
  server_name: CHANNEL_SERVER_NAME,
}));

const code = await runCli(process.argv);
process.exitCode = code;
