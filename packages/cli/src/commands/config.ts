/**
 * `caesar config`: launches the configuration TUI (OpenTUI, under Bun — see
 * the task 8 brief).
 *
 * OpenTUI renders through Bun's FFI; Node 24 does not allow it (it would
 * take Node 26.4 with `--experimental-ffi`, absent from this machine). This
 * command therefore looks for `bun` in the `PATH` — reusing
 * `findBinaryInPath` from `@caesar/core`, the same lookup `caesar doctor`
 * does for each agent, rather than writing a second one — and, if it is
 * missing, explains the situation and points to the equivalent subcommands
 * instead of failing dryly.
 *
 * `packages/tui` is never imported statically here: this module is compiled
 * by `tsc`, which must never attempt to process the `.tsx` meant for Bun.
 * Its path is resolved dynamically via `@caesar/tui/package.json`, declared
 * as a dependency in `package.json` so that Node resolution finds it in
 * `node_modules`.
 *
 * This path (spawning an external `bun`) is the one for development in the
 * monorepo, and for a classic installation: it stays unchanged by default.
 * The compiled binary (task 12) no longer has a `node_modules` to resolve
 * anything from — `resolveTuiEntry` would always fail there.
 * `configureInProcessTui`, called exactly once by
 * `packages/cli/src/bun-entry.ts` (which, itself, imports `@caesar/tui`
 * statically — that is what embeds it into the binary), provides a launcher
 * that mounts the TUI directly in the current process rather than in a
 * subprocess: a single binary, no path resolution, Bun no longer needs to
 * be installed separately since it is inside.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { findBinaryInPath } from "@caesar/core";
import type { Io } from "../output.js";
import { EXIT_RUNTIME, printError, writeLine } from "../output.js";

/** In-process TUI launcher (task 12): mounts the renderer in the current process and returns the exit code once the TUI closes. */
export type InProcessTuiLauncher = (root: string) => Promise<number>;

let inProcessTui: InProcessTuiLauncher | undefined;

/**
 * Extension point called by `bun-entry.ts` at compiled-binary startup. As
 * long as it is never called — the case of the Node path, `bin.ts` never
 * calls it — `runConfig` keeps its historical behavior (spawning an
 * external `bun`, below), identically.
 */
export function configureInProcessTui(launcher: InProcessTuiLauncher | undefined): void {
  inProcessTui = launcher;
}

/** `<...>/packages/tui/src/main.tsx`, from the `package.json` of `@caesar/tui` as Node resolves it. */
function resolveTuiEntry(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@caesar/tui/package.json");
  return join(dirname(packageJsonPath), "src", "main.tsx");
}

function explainMissingBun(io: Io): void {
  printError(
    io,
    'The configuration TUI requires Bun: OpenTUI renders through its FFI, which Node 24 does not allow (it would take Node 26.4 with "--experimental-ffi"). "bun" was not found in the PATH.',
  );
  writeLine(io.stderr, "Install Bun (https://bun.sh), or use the equivalent subcommands:");
  writeLine(io.stderr, "  - caesar policy show   Effective policy (allow/deny, provenance).");
  writeLine(io.stderr, "  - caesar role list     Roles, fallback agents, agent picked today.");
  writeLine(io.stderr, "  - caesar agents list   Agent catalog: presence, capabilities, authorization.");
}

export async function runConfig(root: string, io: Io): Promise<number> {
  if (inProcessTui) {
    return inProcessTui(root);
  }

  const bunPath = await findBinaryInPath("bun");
  if (!bunPath) {
    explainMissingBun(io);
    return EXIT_RUNTIME;
  }

  let entry: string;
  try {
    entry = resolveTuiEntry();
  } catch (error) {
    printError(
      io,
      `Cannot locate the TUI ("@caesar/tui" not found in the dependencies): ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_RUNTIME;
  }

  // Three inherited streams (stdio: "inherit"): the TUI takes the terminal
  // directly, `io` plays no part here (it only serves the diagnostics
  // before the launch, above). The TUI's exit code becomes the command's.
  return await new Promise<number>((resolvePromise) => {
    const child = spawn(bunPath, [entry, root], { stdio: "inherit" });
    child.on("error", (error) => {
      printError(io, `Failed to launch the TUI: ${error.message}`);
      resolvePromise(EXIT_RUNTIME);
    });
    child.on("exit", (code) => {
      resolvePromise(code ?? EXIT_RUNTIME);
    });
  });
}
