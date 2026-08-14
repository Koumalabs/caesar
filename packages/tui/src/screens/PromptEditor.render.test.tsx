/**
 * The prompt editor is the only TUI screen that writes a file without
 * going through "s": these tests therefore cover what it **writes** as
 * much as what it displays.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { PromptEditor } from "./PromptEditor";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-prompt-editor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  setup: Awaited<ReturnType<typeof testRender>>;
  closes: boolean[];
  messages: Array<{ text: string; isError: boolean }>;
}

async function mount(file = "roles/reviewer.md"): Promise<Harness> {
  const closes: boolean[] = [];
  const messages: Array<{ text: string; isError: boolean }> = [];
  const setup = await act(async () =>
    testRender(
      <PromptEditor
        root={root}
        roleName="reviewer"
        systemPromptFile={file}
        onClose={(saved) => closes.push(saved)}
        notify={(text, isError = false) => messages.push({ text, isError })}
      />,
      // 120 and not 100: the displayed absolute path (tmpdir + "caesar-prompt-editor-…")
      // exceeds 100 columns on macOS, and a wrapped path would escape toContain.
      { width: 120, height: 24 },
    ),
  );
  // The file read is asynchronous: the textarea is only mounted afterwards.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await setup.renderOnce();
  });
  return { setup, closes, messages };
}

/**
 * A lone Escape key stays pending in the keyboard decoder — `\x1b` is also
 * the first byte of every escape sequence, which must be allowed to arrive
 * before deciding. A real terminal flushes that wait after a few
 * milliseconds; the test harness, for its part, does not advance on its
 * own: without this pause, Escape never reaches the screen.
 */
async function pressEscape(setup: Harness["setup"]): Promise<void> {
  await act(async () => {
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  // Second `act`: the first only renders what React had already committed
  // before the keystroke. Painting in the same block would capture the
  // previous screen.
  await act(async () => setup.renderOnce());
}

describe("PromptEditor", () => {
  it("shows the absolute path actually read by the engine", async () => {
    // Without it, one edits blindly: a role coming from the global layer
    // resolves its prompt in the current project, which only the path shows.
    await mkdir(join(root, ".caesar", "roles"), { recursive: true });
    await writeFile(join(root, ".caesar", "roles", "reviewer.md"), "You are strict.", "utf8");

    const { setup } = await mount();
    const frame = setup.captureCharFrame();
    expect(frame).toContain(join(root, ".caesar", "roles", "reviewer.md"));
    expect(frame).toContain("You are strict.");
    setup.renderer.destroy();
  });

  it("announces a file that does not exist yet rather than showing an ambiguous blank", async () => {
    const { setup } = await mount();
    expect(setup.captureCharFrame()).toContain("New file");
    setup.renderer.destroy();
  });

  it("Ctrl+S writes the file, says so, and hands control back", async () => {
    const { setup, closes, messages } = await mount();

    await act(async () => {
      await setup.mockInput.typeText("Do not fix anything yourself.");
      await setup.renderOnce();
    });
    await act(async () => setup.mockInput.pressKey("s", { ctrl: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await setup.renderOnce();
    });

    const written = await readFile(join(root, ".caesar", "roles", "reviewer.md"), "utf8");
    expect(written).toBe("Do not fix anything yourself.");
    expect(closes).toEqual([true]);
    expect(messages[0]?.text).toContain("saved");
    setup.renderer.destroy();
  });

  it("Esc on a modified text warns first, only abandons on the second keystroke", async () => {
    const { setup, closes } = await mount();

    await act(async () => {
      await setup.mockInput.typeText("an addition");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await setup.renderOnce();
    });

    await pressEscape(setup);
    expect(closes).toEqual([]); // nothing is abandoned on the first keystroke
    expect(setup.captureCharFrame()).toContain("Unsaved changes");

    await pressEscape(setup);
    expect(closes).toEqual([false]);
    setup.renderer.destroy();
  });

  it("Esc on an unchanged text hands control back immediately", async () => {
    const { setup, closes } = await mount();
    await pressEscape(setup);
    expect(closes).toEqual([false]);
    setup.renderer.destroy();
  });

  it("says that the write is independent of the global \"s\"", async () => {
    const { setup } = await mount();
    expect(setup.captureCharFrame()).toContain("save the file");
    setup.renderer.destroy();
  });
});
