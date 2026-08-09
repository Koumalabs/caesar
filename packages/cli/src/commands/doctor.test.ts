import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIo, withFakeHome, withShimmedPath, writeVersionFailShim, writeVersionOkShim, type CapturedIo } from "../../test/support.js";
import { runDoctor } from "./doctor.js";
import { EXIT_OK } from "../output.js";

describe("orch doctor", () => {
  let root: string;
  let shimDir: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-doctor-root-"));
    shimDir = await mkdtemp(join(tmpdir(), "orch-cli-doctor-shim-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("un agent installé et répondant à --version, un agent absent : les deux apparaissent correctement", async () => {
    await withFakeHome(async () => {
      // "codex" (premier du catalogue) est le seul shimmé : présent avec une
      // version connue. Les quatre autres restent absents (PATH maîtrisé,
      // voir withShimmedPath) — jamais un vrai CLI d'agent n'est invoqué.
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

  it("un binaire installé qui échoue sur --version est signalé \"version inconnue\", sans bloquer la commande", async () => {
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

  it("sortie humaine : tableau puis section \"à corriger\"", async () => {
    await withFakeHome(async () => {
      const code = await withShimmedPath(shimDir, () => runDoctor(root, {}, io));
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("codex");
      expect(io.stdoutText()).toContain("À corriger");
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });
});
