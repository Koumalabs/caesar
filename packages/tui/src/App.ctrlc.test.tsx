/**
 * Ctrl+C with pending changes must never terminate the process without
 * confirmation — see the correction report of task 8 (critical review
 * finding). `main.tsx` disables OpenTUI's automatic exit on Ctrl+C
 * (`exitOnCtrlC: false`) precisely so that `App` can intercept the key
 * itself and route it through the same path as "q" (`isDirty` then
 * confirmation). This test mounts `App` with the same renderer
 * configuration as `main.tsx` (`createTestRenderer` + `createRoot`,
 * exactly the duo `main.tsx` uses with `createCliRenderer`) and verifies
 * the actual behavior, not just a reading of the code.
 *
 * Same theme, same safeguard (task 15): switching the editing scope ("p")
 * with pending changes must not silently discard them either — reuses the
 * same harness (`mountApp`/`waitForLoaded` below) to verify it.
 *
 * `HOME` and `PATH` are neutralized (temporary directories, `PATH` with no
 * real binary): `loadConfigState`/`saveConfigState` never touch the user's
 * real configuration, and `detectAgentInstallation` — called on mount by
 * `App` — finds no binary to probe, so it never invokes a real agent CLI
 * (`findBinaryInPath` fails before any `--version`).
 *
 * `process.exit` is neutralized during these two tests: if the behavior
 * regressed, the real `process.exit` would kill the test runner itself
 * rather than cleanly failing the assertion.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { configPathFor } from "@caesar/core";
import { App } from "./App";

let home: string;
let root: string;
let emptyPath: string;
let previousHome: string | undefined;
let previousPath: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "caesar-tui-ctrlc-home-"));
  root = await mkdtemp(join(tmpdir(), "caesar-tui-ctrlc-root-"));
  emptyPath = await mkdtemp(join(tmpdir(), "caesar-tui-ctrlc-path-"));
  previousHome = process.env["HOME"];
  previousPath = process.env["PATH"];
  process.env["HOME"] = home;
  process.env["PATH"] = emptyPath; // No real binary: no agent detected as "installed", no subprocess spawned.
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (previousPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = previousPath;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(emptyPath, { recursive: true, force: true });
});

/** Mounts `<App>` exactly like `main.tsx`: renderer created first, passed to `createRoot` and as a prop to `App`. */
async function mountApp(): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  await act(async () => {
    createRoot(setup.renderer).render(<App root={root} renderer={setup.renderer} />);
  });
  await act(async () => setup.renderOnce());
  return setup;
}

/** Waits for `state` to be loaded (see `App`: shows "Loading…" until it is). */
async function waitForLoaded(setup: TestRendererSetup): Promise<void> {
  await setup.waitForFrame((frame) => frame.includes("unsaved changes") || frame.includes("all changes saved"));
}

// The two tests below set `exitOnCtrlC: false` themselves on the test
// renderer (`mountApp`): they prove that `App` handles Ctrl+C correctly in
// this configuration, but never actually run `main.tsx` — a regression
// removing the option there would therefore be caught by neither of them
// (task 10, C). A test that really executed `main.tsx` would touch
// `process.argv`/a real `CliRenderer` for a marginal benefit; checking
// that the source file passes the option to `createCliRenderer` suffices.
describe("main.tsx (minimal wiring, without mounting the TUI)", () => {
  it("disables exitOnCtrlC on the renderer it creates", async () => {
    const source = await readFile(new URL("./main.tsx", import.meta.url), "utf8");
    const call = source.match(/createCliRenderer\(([^)]*)\)/);
    expect(call, "main.tsx must call createCliRenderer(...)").not.toBeNull();
    expect(call![1]).toMatch(/exitOnCtrlC:\s*false/);
  });
});

describe("Ctrl+C", () => {
  it("with pending changes: shows the confirmation, does not quit", async () => {
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (() => {
      exitCalled = true;
      throw new Error("process.exit called while a confirmation was expected");
    }) as typeof process.exit;

    try {
      const setup = await mountApp();
      await waitForLoaded(setup);

      // Space on the first row (Agents, default tab) toggles the first
      // catalog agent's permission: a real pending change, the same one
      // tested at the `config-state.ts` level (`toggleAgentDenied`).
      // `pressKey` takes the raw character to inject, not a key name:
      // " " (space), not the string "space" (which would type five
      // letters, including "s" — trap found while writing this test, see
      // the correction report).
      await act(async () => setup.mockInput.pressKey(" "));
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("unsaved changes");

      await act(async () => setup.mockInput.pressCtrlC());
      await act(async () => setup.renderOnce());

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Unsaved changes");
      expect(frame).toContain("Quit anyway");
      expect(exitCalled).toBe(false);

      setup.renderer.destroy();
    } finally {
      process.exit = originalExit;
    }
  });

  it("without a pending change: quits directly (same path as \"q\")", async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    try {
      const setup = await mountApp();
      await waitForLoaded(setup);
      expect(setup.captureCharFrame()).toContain("all changes saved");

      await act(async () => setup.mockInput.pressCtrlC());
      await act(async () => setup.renderOnce());

      expect(exitCode).toBe(0);
    } finally {
      process.exit = originalExit;
    }
  });
});

describe("editing scope", () => {
  it("the status bar shows the active scope at all times, \"project\" on startup", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("SCOPE: PROJECT");
    setup.renderer.destroy();
  });

  it("\"p\" without a pending change switches scope directly, without confirmation", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);
    expect(setup.captureCharFrame()).toContain("SCOPE: PROJECT");

    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());

    const frame = setup.captureCharFrame();
    expect(frame).toContain("SCOPE: LOCAL"); // project → local, the next notch of the cycle
    expect(frame).not.toContain("Unsaved changes");
    setup.renderer.destroy();
  });

  it("\"p\" with pending changes asks for confirmation, changes nothing until it is given", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);

    // A real pending change on the "project" layer (see the Ctrl+C test above, same gesture).
    await act(async () => setup.mockInput.pressKey(" "));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("unsaved changes");

    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Unsaved changes");
    expect(frame).toContain("SCOPE: PROJECT"); // still "project": nothing changed until it is confirmed

    // "n" cancels: the scope and the pending change both survive.
    await act(async () => setup.mockInput.pressKey("n"));
    await act(async () => setup.renderOnce());
    frame = setup.captureCharFrame();
    expect(frame).toContain("SCOPE: PROJECT");
    expect(frame).toContain("unsaved changes");

    // "p" again then "y" confirms: the scope changes, and the pending change is discarded
    // (never silently: the explicit confirmation above was required).
    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    await act(async () => setup.mockInput.pressKey("y"));
    await act(async () => setup.renderOnce());
    frame = setup.captureCharFrame();
    expect(frame).toContain("SCOPE: LOCAL");
    expect(frame).toContain("all changes saved"); // the new layer ("local"), for its part, has nothing pending

    setup.renderer.destroy();
  });

  it("the scenario that matters, through the real interface: \"p\" up to \"global\", then \"s\" writes only the global file", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);

    // project → local → global: two "p", no pending change between the two so no confirmation.
    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("SCOPE: GLOBAL");

    // Space on the first row (Agents tab, the default): a real change, pending on "global".
    await act(async () => setup.mockInput.pressKey(" "));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("unsaved changes");

    await act(async () => setup.mockInput.pressKey("s"));
    // `saveConfigState` is asynchronous (disk write, outside OpenTUI's render scheduler):
    // `waitForFrame` stops as soon as it believes the scheduler is idle, before the disk write
    // has had time to resolve — polling at real intervals (like `IntegrationsScreen.
    // render.test.tsx`, same pattern) is more reliable here than a single short wait.
    let frame = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      await act(async () => {
        await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 100));
        await setup.renderOnce();
      });
      frame = setup.captureCharFrame();
      // Poll only for the appearance of the confirmation message. An exit
      // condition of the kind "the 'saving…' indicator has disappeared"
      // would depend on the exact status-bar label, and left the loop on
      // the first turn when that label changed case.
      if (frame.includes("Saved to")) break;
    }
    // The confirmation message names the written file and the layer — it
    // wraps onto two lines when it exceeds the terminal width: checking
    // "Saved to"/"global layer" separately avoids depending on that visual
    // sequence.
    expect(frame).toContain("Saved to");
    expect(frame).toContain("global layer");

    const globalContent = await readFile(configPathFor("global", root), "utf8");
    expect(globalContent).toContain("denied");

    // The project file, for its part, was never created: no write touched that layer.
    await expect(readFile(configPathFor("project", root), "utf8")).rejects.toThrow();

    setup.renderer.destroy();
  });
});
