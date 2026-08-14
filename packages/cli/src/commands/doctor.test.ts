import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveLayer } from "@caesar/core";
import { makeIo, withFakeHome, withShimmedPath, writeVersionFailShim, writeVersionOkShim, type CapturedIo } from "../../test/support.js";
import { runDoctor } from "./doctor.js";
import { EXIT_OK, terminalWidth } from "../output.js";

describe("caesar doctor", () => {
  let root: string;
  let shimDir: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-doctor-root-"));
    shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-doctor-shim-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("one agent installed and answering --version, one agent missing: both appear correctly", async () => {
    await withFakeHome(async () => {
      // "codex" (first of the catalog) is the only one shimmed: present
      // with a known version. The four others stay missing (controlled
      // PATH, see withShimmedPath) — no real agent CLI is ever invoked.
      await writeVersionOkShim(shimDir, "codex", "codex-shim 9.9.9");

      const code = await withShimmedPath(shimDir, () => runDoctor(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);

      const parsed = JSON.parse(io.stdoutText());
      const codex = parsed.agents.find((a: { id: string }) => a.id === "codex");
      expect(codex.installed).toBe(true);
      expect(codex.version).toBe("codex-shim 9.9.9");
      expect(parsed.missing).not.toContain("codex");

      const antigravity = parsed.agents.find((a: { id: string }) => a.id === "antigravity");
      expect(antigravity.installed).toBe(false);
      expect(antigravity.version).toBeUndefined();
      expect(parsed.missing).toContain("antigravity");
    });
  });

  it("an agent declared by explicit path does not send people to the PATH when the path points at nothing", async () => {
    await withFakeHome(async () => {
      await saveLayer("project", root, { agents: [{ id: "my-cli", bin: "/opt/nothing/at/all", args: ["{{prompt}}"] }] });

      await withShimmedPath(shimDir, () => runDoctor(root, {}, io));
      const out = io.stdoutText();

      // Short fragment: the bullets are wrapped to the terminal width
      // (`wrapText`), a full sentence would land on two lines.
      expect(out).toMatch(/"\/opt\/nothing\/at\/all" does not exist/);
      // The advice must be about the path, not about an installation.
      expect(out).toMatch(/Fix the path/);
      // The native agents, for their part, remain described by their absence from the PATH.
      expect(out).toMatch(/binary "codex" not found in the PATH/);
    });
  });

  it("an installed binary that fails on --version is flagged \"unknown version\", without blocking the command", async () => {
    await withFakeHome(async () => {
      await writeVersionFailShim(shimDir, "codex");

      const code = await withShimmedPath(shimDir, () => runDoctor(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);

      const parsed = JSON.parse(io.stdoutText());
      const codex = parsed.agents.find((a: { id: string }) => a.id === "codex");
      expect(codex.installed).toBe(true);
      expect(codex.version).toBeUndefined();
    });
  });

  it("human output: compact table, then what is to install and what is denied", async () => {
    await withFakeHome(async () => {
      const code = await withShimmedPath(shimDir, () => runDoctor(root, {}, io));
      expect(code).toBe(EXIT_OK);
      const out = io.stdoutText();
      expect(out).toContain("codex");
      expect(out).toContain("TO INSTALL");
      expect(out).not.toMatch(/\x1b\[/);

      // A missing binary calls for an action, a denied agent calls for
      // none: filing them under a single "To fix" amounted to suggesting to
      // undo an intended denial — that of `claude` by `allow_recursion`,
      // which is the default setting.
      expect(out).not.toContain("To fix");

      // The "binary" column is no longer in the default view: the path,
      // added to the capabilities spelled out, is what made it overflow.
      expect(out).not.toMatch(/│\s*binary\s*│/);
    });
  });

  it("--verbose restores the binary column", async () => {
    await withFakeHome(async () => {
      const code = await withShimmedPath(shimDir, () => runDoctor(root, { verbose: true }, io));
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/│\s*agent\s*│\s*binary\s*│\s*version/);
    });
  });

  it("no line exceeds the terminal width", async () => {
    // The defect observed in use: the capabilities enumeration pushed the
    // last column past the edge, where the terminal wrapped it onto the
    // next line — the table became unreadable precisely where it was meant
    // to inform. Checked on both views, the compact and the detailed one:
    // it is `renderTable` that caps, not the choice of columns.
    await withFakeHome(async () => {
      for (const options of [{}, { verbose: true }]) {
        const io2 = makeIo();
        await withShimmedPath(shimDir, () => runDoctor(root, options, io2));
        const tooWide = io2
          .stdoutText()
          .split("\n")
          .filter((line) => line.length > terminalWidth());
        expect(tooWide).toEqual([]);
      }
    });
  });
});
