import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalConfigPath, loadConfig, projectConfigPath } from "@caesar/core";
import { makeIo, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runInit } from "./init.js";
import { runPolicyAllow, runPolicyDeny, runPolicyShow } from "./policy.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

describe("caesar policy allow / deny", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-policy-"));
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

describe("caesar policy show", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-policy-show-"));
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
    const home = await mkdtemp(join(tmpdir(), "caesar-cli-policy-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), "[policy]\nmax_parallel = 9\nallow_recursion = true\n", "utf8");

      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");

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

/**
 * I11 (revue finale de branche) : un seul "caesar policy deny" recopiait la
 * configuration fusionnée (défauts + global + projet) dans le fichier
 * projet, figeant tous les réglages globaux. Ce scénario passe par la
 * façade CLI (pas par `materializePolicyList` directement — c'est elle qui
 * était défaillante), avec un `HOME` neutralisé, exactement le scénario de
 * vérification du brief de la tâche 13.
 */
describe("I11 fermé : la façade CLI n'aplatit plus la configuration fusionnée dans le projet", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-i11-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('"policy deny --global" puis "init" puis "policy deny" (projet) : le fichier projet ne porte que "denied"', async () => {
    await withFakeHome(async () => {
      expect(await runPolicyDeny(root, "copilot", { global: true }, makeIo())).toBe(EXIT_OK);
      expect(await runInit(root, {}, makeIo())).toBe(EXIT_OK);
      expect(await runPolicyDeny(root, "opencode", {}, makeIo())).toBe(EXIT_OK);

      // Le contenu *exact* du fichier projet, pas seulement la valeur effective relue : c'est la preuve que le
      // défaut est fermé — uniquement "denied", aucun défaut recopié (pas de max_parallel, pas de rôles).
      const raw = await readFile(projectConfigPath(root), "utf8");
      expect(raw).toBe(
        "# Fichier généré par @caesar/core : les commentaires ajoutés à la main ne survivent pas à une prochaine écriture.\n" +
          "\n" +
          "[policy]\n" +
          'denied = [ "copilot", "opencode" ]\n',
      );

      const { config } = await loadConfig(root);
      expect(config.policy.denied).toEqual(["copilot", "opencode"]);
    });
  });

  it("modifier max_parallel dans le fichier global après coup se répercute dans le projet (caesar policy show)", async () => {
    await withFakeHome(async (home) => {
      expect(await runPolicyDeny(root, "copilot", { global: true }, makeIo())).toBe(EXIT_OK);
      expect(await runInit(root, {}, makeIo())).toBe(EXIT_OK);
      expect(await runPolicyDeny(root, "opencode", {}, makeIo())).toBe(EXIT_OK);

      // Modifie le fichier global directement, à la main — exactement le scénario du brief : "en modifiant
      // max_parallel dans le fichier global, caesar policy show dans le projet doit refléter la nouvelle valeur".
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot"]\nmax_parallel = 11\n', "utf8");

      const io = makeIo();
      expect(await runPolicyShow(root, { json: true }, io)).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.policy.max_parallel).toBe(11);
      expect(parsed.provenance.max_parallel).toBe("global");
      // La matérialisation faite plus tôt sur "denied" tient toujours, indépendante du changement global.
      expect(parsed.policy.denied).toEqual(["copilot", "opencode"]);
    });
  });
});

describe("caesar policy allow / deny — portée (--global/--local)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-policy-scope-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--global écrit la couche globale, jamais le projet", async () => {
    await withFakeHome(async (home) => {
      expect(await runPolicyDeny(root, "copilot", { global: true }, makeIo())).toBe(EXIT_OK);

      const raw = await readFile(globalConfigPath(), "utf8");
      expect(raw).toBe(
        "# Fichier généré par @caesar/core : les commentaires ajoutés à la main ne survivent pas à une prochaine écriture.\n" +
          "\n" +
          "[policy]\n" +
          'denied = [ "copilot" ]\n',
      );

      const { sources } = await loadConfig(root);
      expect(sources.project).toBeUndefined();
      expect(sources.global).toBe(join(home, ".config", "caesar", "config.toml"));
    });
  });

  it("--local écrit la couche locale, jamais le projet ni le global", async () => {
    await withFakeHome(async () => {
      expect(await runPolicyAllow(root, "codex", { local: true }, makeIo())).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".caesar", "config.local.toml"), "utf8");
      expect(raw).toBe(
        "# Fichier généré par @caesar/core : les commentaires ajoutés à la main ne survivent pas à une prochaine écriture.\n" +
          "\n" +
          "[policy]\n" +
          'allowed = [ "codex" ]\n',
      );

      const { sources } = await loadConfig(root);
      expect(sources.project).toBeUndefined();
      expect(sources.local).toBe(join(root, ".caesar", "config.local.toml"));
    });
  });

  it("sans option : couche projet, comme avant la tâche 13", async () => {
    await withFakeHome(async () => {
      expect(await runPolicyDeny(root, "codex", {}, makeIo())).toBe(EXIT_OK);
      const { sources } = await loadConfig(root);
      expect(sources.project).toBe(projectConfigPath(root));
      expect(sources.global).toBeUndefined();
    });
  });

  it("--global et --local ensemble : erreur d'usage explicite, rien n'est écrit sur aucune couche", async () => {
    await withFakeHome(async () => {
      const io = makeIo();
      const code = await runPolicyDeny(root, "copilot", { global: true, local: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--global/);
      expect(io.stderrText()).toMatch(/--local/);
      expect(io.stderrText()).toMatch(/mutuellement exclusifs/);

      const { sources } = await loadConfig(root);
      expect(sources).toEqual({});
    });
  });

  it("avertit quand la liste éditée n'était pas déclarée par la couche visée (matérialisation)", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot"]\n', "utf8");

      const io = makeIo();
      expect(await runPolicyDeny(root, "opencode", {}, io)).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/n'était pas déclarée/);
      expect(io.stdoutText()).toContain("copilot, opencode");
    });
  });
});
