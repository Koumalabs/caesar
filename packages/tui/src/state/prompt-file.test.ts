import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRole, saveLayer } from "@caesar/core";
import { defaultPromptFileFor, readPromptFile, validatePromptFile, writePromptFile } from "./prompt-file";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-prompt-file-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("reading", () => {
  it("a missing file is not an error: empty content, and it says so", async () => {
    const file = await readPromptFile(root, "roles/reviewer.md");
    expect(file.exists).toBe(false);
    expect(file.content).toBe("");
    expect(file.path).toBe(join(root, ".caesar", "roles", "reviewer.md"));
  });

  it("returns the content and the absolute path", async () => {
    await mkdir(join(root, ".caesar", "roles"), { recursive: true });
    await writeFile(join(root, ".caesar", "roles", "reviewer.md"), "You are strict.", "utf8");
    const file = await readPromptFile(root, "roles/reviewer.md");
    expect(file).toEqual({ path: join(root, ".caesar", "roles", "reviewer.md"), content: "You are strict.", exists: true });
  });
});

describe("writing", () => {
  it("creates the intermediate directories — a fresh role does not have a roles/ yet", async () => {
    const path = await writePromptFile(root, "roles/new.md", "Hello.");
    expect(await readFile(path, "utf8")).toBe("Hello.");
  });

  it("leaves no temporary file behind", async () => {
    await writePromptFile(root, "roles/x.md", "one");
    await writePromptFile(root, "roles/x.md", "two");
    const entries = await readdir(join(root, ".caesar", "roles"));
    expect(entries).toEqual(["x.md"]);
  });

  it("what is written is exactly what the engine will read back", async () => {
    // The property that matters, and the reason `rolePromptPath` exists: if
    // the editor and `resolveRole` did not target the same file, the edited
    // prompt would not be the one passed to the agent, without anything
    // saying so.
    await saveLayer("project", root, {
      roles: [
        {
          name: "reviewer",
          purpose: "Reviews.",
          agents: ["codex"],
          mode: "read-only",
          isolation: "auto",
          network: "auto",
          timeout_ms: 600_000,
          system_prompt_file: "roles/reviewer.md",
        },
      ],
    });
    await writePromptFile(root, "roles/reviewer.md", "Do not fix anything yourself.");

    const { config } = await loadConfig(root);
    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved?.systemPrompt).toBe("Do not fix anything yourself.");
  });
});

describe("path validation", () => {
  it("accepts a relative path", () => {
    expect(validatePromptFile("roles/reviewer.md")).toBeNull();
  });

  it("refuses an empty path", () => {
    expect(validatePromptFile("  ")).toMatch(/cannot be empty/);
  });

  it("refuses an absolute path, which would silently become relative", () => {
    // `join(root, ".caesar", "/etc/prompt.md")` yields `<root>/.caesar/etc/prompt.md`:
    // one believes one is naming a system file, another gets created.
    expect(validatePromptFile("/etc/prompt.md")).toMatch(/Absolute/);
  });

  it('refuses a ".." that would leave the configuration directory', () => {
    expect(validatePromptFile("../../elsewhere.md")).toMatch(/\.\./);
  });
});

describe("default path", () => {
  it('follows the convention "caesar init" already writes', () => {
    expect(defaultPromptFileFor("investigator")).toBe("roles/investigator.md");
  });
});
