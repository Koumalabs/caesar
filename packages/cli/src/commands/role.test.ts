import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@orch/core";
import { makeIo, withFakeHome, withShimmedPath, writeVersionOkShim, type CapturedIo } from "../../test/support.js";
import { runPolicyDeny } from "./policy.js";
import { runRoleAdd, runRoleList, runRoleRemove, runRoleShow } from "./role.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

describe("orch role list", () => {
  let root: string;
  let shimDir: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-role-list-"));
    shimDir = await mkdtemp(join(tmpdir(), "orch-cli-role-list-shim-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("retient le premier choix quand il est installé et autorisé", async () => {
    await withFakeHome(async () => {
      // Le rôle "reviewer" par défaut a pour ordre de repli codex > antigravity :
      // les deux sont shimmés "installés", donc codex (premier) doit être retenu.
      await writeVersionOkShim(shimDir, "codex", "codex 1.0.0");
      await writeVersionOkShim(shimDir, "agy", "agy 1.0.0");

      const code = await withShimmedPath(shimDir, () => runRoleList(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      const reviewer = parsed.roles.find((r: { name: string }) => r.name === "reviewer");
      expect(reviewer.picked).toBe("codex");
    });
  });

  it("replie sur le deuxième choix quand le premier n'est pas installé", async () => {
    await withFakeHome(async () => {
      // Seul antigravity est shimmé "installé" : codex, absent du PATH maîtrisé,
      // doit être écarté au profit d'antigravity pour "reviewer".
      await writeVersionOkShim(shimDir, "agy", "agy 1.0.0");

      const code = await withShimmedPath(shimDir, () => runRoleList(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      const reviewer = parsed.roles.find((r: { name: string }) => r.name === "reviewer");
      expect(reviewer.picked).toBe("antigravity");
    });
  });

  it("replie sur le deuxième choix quand le premier est refusé par la politique, même installé", async () => {
    await withFakeHome(async () => {
      await writeVersionOkShim(shimDir, "codex", "codex 1.0.0");
      await writeVersionOkShim(shimDir, "agy", "agy 1.0.0");
      await runPolicyDeny(root, "codex", {}, makeIo());

      const code = await withShimmedPath(shimDir, () => runRoleList(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      const reviewer = parsed.roles.find((r: { name: string }) => r.name === "reviewer");
      expect(reviewer.picked).toBe("antigravity");
    });
  });

  it("sortie humaine : un tableau nommant le rôle retenu aujourd'hui", async () => {
    await withFakeHome(async () => {
      const code = await withShimmedPath(shimDir, () => runRoleList(root, {}, io));
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("reviewer");
      expect(io.stdoutText()).toContain("retenu aujourd'hui");
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });
});

describe("orch role show / add / remove", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-role-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("show : détail d'un rôle connu, prompt système compris", async () => {
    await withFakeHome(async () => {
      const code = await runRoleShow(root, "reviewer", { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.name).toBe("reviewer");
      expect(parsed.systemPrompt).toBe("");
    });
  });

  it("show : rôle inconnu, code d'usage", async () => {
    await withFakeHome(async () => {
      const code = await runRoleShow(root, "inexistant", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/inconnu/);
    });
  });

  it("add : crée un rôle avec les options fournies, puis remove le supprime", async () => {
    await withFakeHome(async () => {
      const code = await runRoleAdd(
        root,
        "custom",
        { purpose: "Rôle de test.", agents: "codex,opencode", mode: "write", isolation: "worktree", timeout: "5m" },
        io,
      );
      expect(code).toBe(EXIT_OK);

      const { config } = await loadConfig(root);
      const custom = config.roles.find((r) => r.name === "custom");
      expect(custom).toMatchObject({
        name: "custom",
        purpose: "Rôle de test.",
        agents: ["codex", "opencode"],
        mode: "write",
        isolation: "worktree",
        timeout_ms: 300_000,
      });

      const io2 = makeIo();
      expect(await runRoleRemove(root, "custom", {}, io2)).toBe(EXIT_OK);
      const reloaded = await loadConfig(root);
      expect(reloaded.config.roles.some((r) => r.name === "custom")).toBe(false);
    });
  });

  it("add : refuse un --mode invalide", async () => {
    await withFakeHome(async () => {
      const code = await runRoleAdd(root, "custom", { agents: "codex", mode: "readonly" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--mode/);
    });
  });

  it("add : refuse une liste --agents vide", async () => {
    await withFakeHome(async () => {
      const code = await runRoleAdd(root, "custom", { mode: "write" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--agents/);
    });
  });

  it("remove : rôle inconnu, code d'usage", async () => {
    await withFakeHome(async () => {
      const code = await runRoleRemove(root, "inexistant", {}, io);
      expect(code).toBe(EXIT_USAGE);
    });
  });
});

describe("orch role add / remove — portée (--global/--local)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-role-scope-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("add --global écrit la couche globale, jamais le projet", async () => {
    await withFakeHome(async () => {
      expect(await runRoleAdd(root, "custom", { agents: "codex", mode: "write", global: true }, makeIo())).toBe(EXIT_OK);

      const { sources, layers } = await loadConfig(root);
      expect(sources.global).toBeDefined();
      expect(sources.project).toBeUndefined();
      const globalLayer = layers.find((l) => l.scope === "global")!;
      expect(globalLayer.override.roles?.map((r) => r.name)).toEqual(["custom"]);
    });
  });

  it("remove --local : retire un rôle déclaré localement, laisse le projet et le global intacts", async () => {
    await withFakeHome(async () => {
      expect(await runRoleAdd(root, "custom", { agents: "codex", mode: "write", local: true }, makeIo())).toBe(EXIT_OK);
      let loaded = await loadConfig(root);
      expect(loaded.config.roles.some((r) => r.name === "custom")).toBe(true);
      expect(loaded.sources.local).toBeDefined();

      expect(await runRoleRemove(root, "custom", { local: true }, makeIo())).toBe(EXIT_OK);
      loaded = await loadConfig(root);
      expect(loaded.config.roles.some((r) => r.name === "custom")).toBe(false);
    });
  });

  it("remove d'un rôle par défaut (non déclaré par aucune couche) : erreur explicite, oriente vers la bonne réponse plutôt qu'un EXIT_OK trompeur", async () => {
    await withFakeHome(async () => {
      const io = makeIo();
      const code = await runRoleRemove(root, "reviewer", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/n'est pas déclaré/);
      expect(io.stderrText()).toMatch(/configuration par défaut/);

      // Le rôle par défaut n'a pas bougé : la commande n'a rien écrit.
      const { config } = await loadConfig(root);
      expect(config.roles.some((r) => r.name === "reviewer")).toBe(true);
    });
  });

  it("remove d'un rôle déclaré par une AUTRE couche que celle visée : erreur qui nomme la bonne couche", async () => {
    await withFakeHome(async () => {
      expect(await runRoleAdd(root, "custom", { agents: "codex", mode: "write", global: true }, makeIo())).toBe(EXIT_OK);

      const io = makeIo();
      // "custom" vient du global : le retirer côté projet (couche par défaut) ne doit rien faire, et le dire.
      const code = await runRoleRemove(root, "custom", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/n'est pas déclaré/);
      expect(io.stderrText()).toMatch(/--global/);

      const { config } = await loadConfig(root);
      expect(config.roles.some((r) => r.name === "custom")).toBe(true);
    });
  });

  it("--global et --local ensemble (add) : erreur d'usage explicite, rien n'est écrit", async () => {
    await withFakeHome(async () => {
      const io = makeIo();
      const code = await runRoleAdd(root, "custom", { agents: "codex", mode: "write", global: true, local: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/mutuellement exclusifs/);

      const { sources } = await loadConfig(root);
      expect(sources).toEqual({});
    });
  });
});
