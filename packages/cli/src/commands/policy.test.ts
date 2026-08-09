import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@orch/core";
import { makeIo, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runPolicyAllow, runPolicyDeny, runPolicyShow } from "./policy.js";
import { EXIT_OK } from "../output.js";

describe("orch policy allow / deny", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-policy-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("allow puis deny : la modification est persistée dans le TOML et relue", async () => {
    await withFakeHome(async () => {
      expect(await runPolicyAllow(root, "codex", {}, io)).toBe(EXIT_OK);
      let loaded = await loadConfig(root);
      expect(loaded.config.policy.allowed).toContain("codex");

      const io2 = makeIo();
      expect(await runPolicyDeny(root, "copilot", {}, io2)).toBe(EXIT_OK);
      loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).toContain("copilot");
      // La modification précédente (allow codex) survit à la suivante.
      expect(loaded.config.policy.allowed).toContain("codex");
    });
  });
});

describe("orch policy show", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-policy-show-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sans aucun fichier : chaque champ vient du défaut", async () => {
    await withFakeHome(async () => {
      const code = await runPolicyShow(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(Object.values(parsed.provenance)).toEqual(Array(Object.keys(parsed.provenance).length).fill("default"));
      expect(parsed.sources).toEqual({});
    });
  });

  it("distingue la provenance global / projet / défaut, champ par champ", async () => {
    const home = await mkdtemp(join(tmpdir(), "orch-cli-policy-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      await mkdir(join(home, ".config", "orch"), { recursive: true });
      await writeFile(join(home, ".config", "orch", "config.toml"), "[policy]\nmax_parallel = 9\nallow_recursion = true\n", "utf8");

      await mkdir(join(root, ".orch"), { recursive: true });
      await writeFile(join(root, ".orch", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");

      const code = await runPolicyShow(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());

      // Précisé par le projet (qui l'emporte sur le global) : provenance "project".
      expect(parsed.policy.max_parallel).toBe(2);
      expect(parsed.provenance.max_parallel).toBe("project");

      // Précisé par le global seulement : provenance "global".
      expect(parsed.policy.allow_recursion).toBe(true);
      expect(parsed.provenance.allow_recursion).toBe("global");

      // Jamais précisé : provenance "default".
      expect(parsed.provenance.default_mode).toBe("default");

      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("sortie humaine : un tableau champ / valeur / provenance", async () => {
    await withFakeHome(async () => {
      const code = await runPolicyShow(root, {}, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("provenance");
      expect(io.stdoutText()).toContain("max_parallel");
      expect(io.stdoutText()).toContain("default");
    });
  });
});
