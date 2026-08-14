import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { RolesScreen } from "./RolesScreen";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-tui-roles-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const callbacks = { onChange: () => {}, onEditingChange: () => {}, notify: () => {} };

async function mount(state = makeState(), size = { width: 120, height: 34 }) {
  const setup = await act(async () =>
    testRender(<RolesScreen root={root} state={state} installed={null} {...callbacks} />, size),
  );
  await act(async () => setup.renderOnce());
  return setup;
}

/** Lets the prompt preview (a file read, asynchronous) arrive before capturing. */
async function settle(setup: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await setup.renderOnce();
  });
}

describe("RolesScreen", () => {
  it("shows the roles and the selected role's fields", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("reviewer");
    expect(frame).toContain("implementer");
    expect(frame).toContain("Purpose");
    expect(frame).toContain("Agents");
    // The role name is now a field in its own right: a role gets renamed
    // without going through the TOML file.
    expect(frame).toContain("Name");
    setup.renderer.destroy();
  });

  it("signals that a role redefined globally is inherited, not declared by the active layer", async () => {
    const state = makeState();
    state.layers[0] = {
      ...state.layers[0]!,
      override: {
        roles: [
          { name: "reviewer", purpose: "Redefined globally.", agents: ["codex"], mode: "read-only", isolation: "inplace", network: "auto", timeout_ms: 600_000 },
        ],
      },
    };
    const setup = await mount(state);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Redefined globally.");
    expect(frame).toContain("Inherited ← global");
    setup.renderer.destroy();
  });

  it("shows the system prompt: its path, its size and its first lines", async () => {
    // The central defect this screen fixes: the prompt only existed on
    // screen as a path, while that file *is* what the agent receives at
    // the head of its context.
    await mkdir(join(root, ".caesar", "roles"), { recursive: true });
    await writeFile(join(root, ".caesar", "roles", "reviewer.md"), "You are a strict reviewer.\nDo not fix anything yourself.\n", "utf8");

    const setup = await mount();
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("roles/reviewer.md");
    expect(frame).toContain("You are a strict reviewer.");
    expect(frame).toContain("characters");
    setup.renderer.destroy();
  });

  it("says that a prompt declared but absent from disk remains to be created", async () => {
    const setup = await mount();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("to be created");
    setup.renderer.destroy();
  });

  it("the key hints follow the focus level", async () => {
    const setup = await mount();
    expect(setup.captureCharFrame()).toContain("new");

    // Entering the fields: the offered keys change.
    await act(async () => setup.mockInput.pressEnter());
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("back to roles");
    // …and the selected field is explained.
    expect(frame).toContain("caesar run --role");
    setup.renderer.destroy();
  });

  it("shows the role's model, and its absence explicitly", async () => {
    const state = makeState();
    state.layers[0] = {
      ...state.layers[0]!,
      override: {
        roles: [
          { name: "reviewer", purpose: "", agents: ["codex"], mode: "read-only", isolation: "inplace", network: "auto", timeout_ms: 600_000, model: "gpt-6" },
        ],
      },
    };
    const setup = await mount(state);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Model");
    expect(frame).toContain("gpt-6");
    setup.renderer.destroy();
  });

  it("a role without a model says the agent's default applies", async () => {
    const setup = await mount();
    expect(setup.captureCharFrame()).toContain("(none — agent default)");
    setup.renderer.destroy();
  });

  it("explains the model field when it is reached", async () => {
    const setup = await mount();
    await act(async () => setup.mockInput.pressEnter());
    // name, purpose, agents, mode, isolation, network, model: six notches down.
    for (let i = 0; i < 6; i++) await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("per-agent [models] default");
    setup.renderer.destroy();
  });

  it("offers to open the editor when the prompt field is reached", async () => {
    const setup = await mount();
    await act(async () => setup.mockInput.pressEnter());
    // name, purpose, agents, mode, isolation, network, model, timeout, prompt: eight notches.
    for (let i = 0; i < 8; i++) await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("edit the prompt");
    expect(frame).toContain("change the file");
    setup.renderer.destroy();
  });

  it("no line overflows the terminal width", async () => {
    for (const width of [80, 120, 200]) {
      const setup = await mount(makeState(), { width, height: 34 });
      await settle(setup);
      for (const line of setup.captureCharFrame().split("\n")) {
        expect(line.trimEnd().length).toBeLessThanOrEqual(width);
      }
      setup.renderer.destroy();
    }
  });
});
