/**
 * What these tests protect, and why: each assertion matches a defect
 * observed in use on the old screen — columns touching each other,
 * capabilities replaced by their count, denial reason running off screen.
 * Verified via `captureCharFrame()`, OpenTUI's internal grid: a real pty
 * capture of the binary turned out unreadable (successive rewrites
 * interleaved in the stream), a capture artifact and not a TUI defect —
 * see the report of task 15.
 */
import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { AgentInstallStatus } from "@caesar/core";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { AgentsScreen } from "./AgentsScreen";

/** The callbacks the screen only triggers on a keystroke: inert in a render test. */
const callbacks = { onToggleDenied: () => {}, onChange: () => {}, onEditingChange: () => {}, notify: () => {} };

/** Five native agents separate the initial selection (codex) from a declaration appended at the end of the catalog. */
const NATIVE_COUNT = 5;

async function mount(
  state = makeState(),
  installed: Map<string, AgentInstallStatus> | null = null,
  size = { width: 100, height: 40 },
) {
  const setup = await act(async () => testRender(<AgentsScreen state={state} installed={installed} {...callbacks} />, size));
  await act(async () => setup.renderOnce());
  return setup;
}

async function pressDown(setup: Awaited<ReturnType<typeof mount>>, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => setup.mockInput.pressKey("j"));
  await act(async () => setup.renderOnce());
}

describe("AgentsScreen — the table", () => {
  it("shows the catalog, its named capabilities, and the detection status", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("codex");
    expect(frame).toContain("antigravity");
    // The fixed defect: the column announced "7 notable(s)" — a count in
    // place of the information.
    expect(frame).not.toContain("notable(s)");
    expect(frame).toContain("resume");
    expect(frame).toContain("Detecting installation");
    setup.renderer.destroy();
  });

  it("never glues two columns together, nor overflows the width", async () => {
    // The original defect, exactly: a truncated value came to touch the
    // next column ("…codex-cli 0.1…7 notable(s)"), and the two read as a
    // single word.
    for (const width of [60, 100, 200]) {
      const setup = await mount(makeState(), null, { width, height: 40 });
      for (const line of setup.captureCharFrame().split("\n")) {
        expect(line.trimEnd().length).toBeLessThanOrEqual(width);
        expect(line).not.toMatch(/…\S/);
      }
      setup.renderer.destroy();
    }
  });
});

describe("AgentsScreen — the selected agent's detail", () => {
  it("shows the binary path, the capabilities in full words, and the roles that employ it", async () => {
    const installed = new Map<string, AgentInstallStatus>([
      ["codex", { id: "codex", bin: "codex", installed: true, path: "/opt/toolchain/bin/codex", version: "1.2.3" }],
    ]);
    const setup = await mount(makeState(), installed);
    const frame = setup.captureCharFrame();
    // The path left the table — same lesson as `caesar doctor` — for the
    // detail, where it no longer competes with the columns useful at a glance.
    expect(frame).toContain("/opt/toolchain/bin/codex");
    expect(frame).toContain("native read-only");
    expect(frame).toContain("Used by");
    expect(frame).toContain("implementer");
    setup.renderer.destroy();
  });

  it("wraps the reason for a denial instead of letting it run off screen", async () => {
    const state = makeState();
    state.draft = { policy: { denied: ["codex"] } };
    const setup = await mount(state, new Map());
    const frame = setup.captureCharFrame();
    // The full reason is a long sentence: it sat on a single line in the
    // old table, thus beyond the edge of the screen.
    expect(frame).toContain('Agent "codex" refused');
    expect(frame).toContain('"denied" list');
    setup.renderer.destroy();
  });

  it("says clearly that a native agent cannot be edited", async () => {
    const setup = await mount();
    expect(setup.captureCharFrame()).toContain("native catalog");
    setup.renderer.destroy();
  });
});

describe("AgentsScreen — default model per agent", () => {
  it("shows the effective default model of a native agent, with its inheritance mark", async () => {
    const state = makeState(); // "project" scope active, the value comes from "global"
    state.layers[0] = { ...state.layers[0]!, override: { models: { codex: "gpt-5.2" } } };
    const setup = await mount(state, new Map());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Default model");
    expect(frame).toContain("gpt-5.2 ← global");
    setup.renderer.destroy();
  });

  it("says explicitly when no default model is configured", async () => {
    const setup = await mount(makeState(), new Map());
    expect(setup.captureCharFrame()).toContain("(none — provider default)");
    setup.renderer.destroy();
  });

  it("flags a default model the agent cannot honor, instead of displaying it as applied", async () => {
    const state = makeState();
    state.draft = { agents: [{ id: "aider", bin: "aider", args: ["{{prompt}}"] }], models: { aider: "x" } };
    const setup = await mount(state, new Map());
    await pressDown(setup, NATIVE_COUNT);
    expect(setup.captureCharFrame()).toContain("(ignored: no model choice)");
    setup.renderer.destroy();
  });

  it('offers the "m" gesture from the list, native agents included', async () => {
    const setup = await mount(makeState(), new Map());
    // Lowercase: the key hint at the bottom of the screen, not the field label.
    expect(setup.captureCharFrame()).toContain("default model");
    setup.renderer.destroy();
  });
});

describe("AgentsScreen — declaring an agent outside the catalog", () => {
  it("lists a declared agent after the native catalog, and marks it", async () => {
    const state = makeState();
    state.draft = { agents: [{ id: "aider", bin: "aider", args: ["--message", "{{prompt}}"], cwdMode: "process" }] };
    const setup = await mount(state, new Map());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("codex"); // the native ones remain
    expect(frame).toContain("aider *"); // the asterisk distinguishes a declaration from a wired-in agent
    expect(frame).toContain("* declared in configuration");
    setup.renderer.destroy();
  });

  it("shows the command line and the editable fields of the selected declared agent", async () => {
    const state = makeState();
    state.draft = { agents: [{ id: "aider", bin: "aider", args: ["--message", "{{prompt}}"], cwdMode: "process" }] };
    const setup = await mount(state, new Map());

    // The panel concerns only the selected row: the editable fields do not
    // appear on "codex" (initial selection, a native agent).
    expect(setup.captureCharFrame()).not.toContain("Arguments");

    await pressDown(setup, NATIVE_COUNT);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("aider --message {{prompt}}");
    expect(frame).toContain("Declared by the active layer");
    expect(frame).toContain("Binary");
    expect(frame).toContain("Arguments");
    setup.renderer.destroy();
  });

  it("explains the selected field once editing is entered", async () => {
    const state = makeState();
    state.draft = { agents: [{ id: "aider", bin: "aider", args: ["{{prompt}}"] }] };
    const setup = await mount(state, new Map());
    await pressDown(setup, NATIVE_COUNT);

    // While still in the list, no field explanation.
    expect(setup.captureCharFrame()).not.toContain("Defaults to its identifier");

    await act(async () => setup.mockInput.pressEnter());
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("Defaults to its identifier");
    setup.renderer.destroy();
  });

  it("signals that an inherited declaration will be redefined on the active layer if edited", async () => {
    const state = makeState(); // "project" scope active, only "global" declares the agent
    state.layers[0] = {
      ...state.layers[0]!,
      override: { agents: [{ id: "aider", bin: "aider", args: ["{{prompt}}"] }] },
    };
    const setup = await mount(state, new Map());
    await pressDown(setup, NATIVE_COUNT);
    expect(setup.captureCharFrame()).toContain("Declared ← global");
    setup.renderer.destroy();
  });

  it("names the network of every catalog agent — the information that was missing", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    // codex only opens the network in write mode, opencode has it open: the
    // two presented themselves identically before this work.
    expect(frame).toContain("net(w)");
    expect(frame).toContain("net");
    setup.renderer.destroy();
  });

  it('signals that "denied" is inherited from the global layer as long as the active layer does not declare it', async () => {
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { denied: ["copilot"] } } };
    const setup = await mount(state);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('"denied" inherited ← global');
    // "allowed" is declared nowhere: inherited from the default, not from "global".
    expect(frame).toContain('"allowed" inherited ← default');
    setup.renderer.destroy();
  });
});
