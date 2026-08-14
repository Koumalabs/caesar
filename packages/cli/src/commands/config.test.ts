import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIo, withShimmedPath, type CapturedIo } from "../../test/support.js";
import { configureInProcessTui, runConfig } from "./config.js";
import { EXIT_RUNTIME } from "../output.js";

/**
 * Deposits a fake "bun" that is nothing like a real runtime: it notes in
 * `captureFile` the arguments it received and its current directory, then
 * exits with `exitCode`. Enough to check what `runConfig` builds and
 * launches, without ever mounting any OpenTUI rendering in the `vitest`
 * tests of `packages/cli` (the real TUI, for its part, runs under `bun
 * test` — see the task report).
 */
async function writeFakeBunShim(dir: string, options: { captureFile: string; exitCode: number }): Promise<void> {
  const target = join(dir, "bun");
  const script = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(options.captureFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.exit(${options.exitCode});
`;
  await writeFile(target, script, "utf8");
  await chmod(target, 0o755);
}

describe("caesar config — bun missing", () => {
  let root: string;
  let shimDir: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-config-root-"));
    shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-config-shim-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("explains the situation, points to the equivalent subcommands, and launches nothing", async () => {
    await withShimmedPath(shimDir, async () => {
      const code = await runConfig(root, io);
      expect(code).toBe(EXIT_RUNTIME);
      expect(io.stderrText()).toMatch(/Bun/);
      expect(io.stderrText()).toContain("caesar policy show");
      expect(io.stderrText()).toContain("caesar role list");
      expect(io.stderrText()).toContain("caesar agents list");
    });
  });
});

describe("caesar config — bun present", () => {
  let root: string;
  let shimDir: string;
  let captureFile: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-config-root-"));
    shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-config-shim-"));
    captureFile = join(shimDir, "capture.json");
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("builds the right command line (the TUI's main.tsx, project root) and propagates the exit code", async () => {
    await writeFakeBunShim(shimDir, { captureFile, exitCode: 0 });
    await withShimmedPath(shimDir, async () => {
      const code = await runConfig(root, io);
      expect(code).toBe(0);

      const captured = JSON.parse(await readFile(captureFile, "utf8")) as { argv: string[]; cwd: string };
      expect(captured.argv).toHaveLength(2);
      expect(captured.argv[0]).toMatch(/packages[\\/]tui[\\/]src[\\/]main\.tsx$/);
      expect(captured.argv[1]).toBe(root);
    });
  });

  it("propagates a non-zero exit code", async () => {
    await writeFakeBunShim(shimDir, { captureFile, exitCode: 7 });
    await withShimmedPath(shimDir, async () => {
      const code = await runConfig(root, io);
      expect(code).toBe(7);
    });
  });
});

describe("caesar config — in-process launcher configured (task 12)", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-config-root-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    // Always restore the absence of a launcher: a test that left a launcher
    // configured would poison all the following tests of this file,
    // including those of the default Node path above.
    configureInProcessTui(undefined);
  });

  it("delegates to the configured launcher rather than looking for \"bun\", and returns its exit code — without ever touching the PATH", async () => {
    let receivedRoot: string | undefined;
    configureInProcessTui(async (r) => {
      receivedRoot = r;
      return 3;
    });

    // No `withShimmedPath` here, deliberately: if `runConfig` mistakenly
    // fell back onto the spawn path (a regression bug), the absence of a
    // shimmed "bun" would make it fail visibly rather than mask the bug by
    // providing a fake binary that would still answer correctly.
    const code = await runConfig(root, io);
    expect(code).toBe(3);
    expect(receivedRoot).toBe(root);
  });
});
