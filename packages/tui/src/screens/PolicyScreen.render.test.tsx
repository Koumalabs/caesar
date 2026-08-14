import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { PolicyScreen } from "./PolicyScreen";

const callbacks = { onChange: () => {}, onEditingChange: () => {}, notify: () => {} };

async function mount(state = makeState(), size = { width: 100, height: 30 }) {
  const setup = await act(async () => testRender(<PolicyScreen state={state} {...callbacks} />, size));
  await act(async () => setup.renderOnce());
  return setup;
}

describe("PolicyScreen", () => {
  it("names each setting in plain language rather than by its TOML key", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    // The defect this screen fixes: "max_parallel", "allow_recursion" and
    // "max_depth" were displayed as-is, without a word saying what they do.
    // A setting one does not understand does not get adjusted.
    expect(frame).toContain("Parallel tasks");
    expect(frame).toContain("Recursive delegation");
    expect(frame).toContain("Denied agents");
    expect(frame).toContain("always wins over");
    setup.renderer.destroy();
  });

  it("explains the selected setting, and the matching TOML key", async () => {
    const setup = await mount();
    // Initial selection: the first setting in the list.
    expect(setup.captureCharFrame()).toContain("What a task does when unspecified");
    expect(setup.captureCharFrame()).toContain("default_mode");

    // Moving down changes the explanation — it follows the selection.
    // default_mode, default_isolation, default_network, default_timeout_ms,
    // max_parallel, max_depth, allow_recursion: six notches down to the
    // recursion setting (FIELDS, PolicyScreen.tsx).
    for (let i = 0; i < 6; i++) await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("allow_recursion");
    // Short fragment: the explanation is wrapped over two lines, a whole
    // sentence would fall astride the break.
    expect(frame).toContain("delegating to Claude");
    setup.renderer.destroy();
  });

  it("the explanation does not shift the settings that follow it", async () => {
    // Rendered inline, it pushed every following field down as soon as it
    // appeared: moving down one notch made the whole list jump. Its room
    // is reserved at the foot of the panel, so the labels stay on the same
    // lines whatever the selection.
    const setup = await mount();
    const lineOf = (frame: string, label: string): number => frame.split("\n").findIndex((line) => line.includes(label));

    const before = lineOf(setup.captureCharFrame(), "Denied agents");
    await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    expect(lineOf(setup.captureCharFrame(), "Denied agents")).toBe(before);
    setup.renderer.destroy();
  });

  it('marks an inherited field "← global", never a field the active layer declares itself', async () => {
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { max_parallel: 9 } } };
    const setup = await mount(state);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("← global");
    // max_depth is declared nowhere: inherited from the default, a different mark.
    expect(frame).toContain("← default");
    setup.renderer.destroy();
  });

  it('no mark when the active layer ("project") declares the field itself', async () => {
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { max_parallel: 9 } } };
    state.draft = { policy: { max_parallel: 3 } };
    const setup = await mount(state);
    expect(setup.captureCharFrame()).not.toContain("← global");
    setup.renderer.destroy();
  });

  it("exposes the default network, with its TOML key and what it does", async () => {
    // The screen is controlled: `onChange` is a no-op in this harness, so
    // the value cannot change here. What is verified at this level is that
    // the setting exists, can be selected, and is explained — the cycling
    // itself belongs to `updatePolicy` (state/config-state.test.ts).
    const setup = await mount();
    expect(setup.captureCharFrame()).toContain("Default network");
    // default_mode, default_isolation, default_network: two notches.
    for (let i = 0; i < 2; i++) await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("default_network");
    expect(frame).toContain("refuses the delegation if the agent cannot open it");
    setup.renderer.destroy();
  });

  it("no line overflows the terminal width, however narrow it is", async () => {
    for (const width of [70, 100, 180]) {
      const setup = await mount(makeState(), { width, height: 30 });
      for (const line of setup.captureCharFrame().split("\n")) {
        expect(line.trimEnd().length).toBeLessThanOrEqual(width);
      }
      setup.renderer.destroy();
    }
  });
});
