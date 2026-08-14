import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@caesar/core";
import { makeIo, withFakeAgentAsBin, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runAgentsAdd, runAgentsDisable, runAgentsEnable, runAgentsList, runAgentsRemove, runAgentsTest } from "./agents.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

describe("caesar agents list", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--json liste le catalogue avec présence, capacités et politique, sans ANSI", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsList(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.agents.map((a: { id: string }) => a.id)).toEqual(["codex", "antigravity", "opencode", "copilot", "claude"]);
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });
});

describe("caesar agents enable / disable", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-toggle-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("disable puis enable : la modification est persistée dans le TOML et relue", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsDisable(root, "codex", {}, io)).toBe(EXIT_OK);
      let loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).toContain("codex");

      const io2 = makeIo();
      expect(await runAgentsEnable(root, "codex", {}, io2)).toBe(EXIT_OK);
      loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).not.toContain("codex");
    });
  });

  it("--json rapporte l'état final de la liste denied", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsDisable(root, "opencode", { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.denied).toContain("opencode");
    });
  });
});

describe("caesar agents add / remove", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-declare-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("déclare un agent, qui rejoint aussitôt le catalogue effectif", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "aider", { bin: "aider", args: "--message {{prompt}} --yes" }, io);
      expect(code).toBe(EXIT_OK);

      const { config } = await loadConfig(root);
      expect(config.agents).toEqual([
        { id: "aider", bin: "aider", args: ["--message", "{{prompt}}", "--yes"], cwdMode: "process" },
      ]);

      // Ce qui compte vraiment : `caesar agents list` le voit, donc `caesar run
      // --agent aider` peut le résoudre.
      const listIo = makeIo();
      await runAgentsList(root, { json: true }, listIo);
      expect(JSON.parse(listIo.stdoutText()).agents.map((a: { id: string }) => a.id)).toContain("aider");
    });
  });

  it("découpe le gabarit en respectant les guillemets", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsAdd(root, "mon-cli", { bin: "mon-cli", args: '--system "tu es {{prompt}}"' }, io)).toBe(EXIT_OK);
      const { config } = await loadConfig(root);
      expect(config.agents[0]!.args).toEqual(["--system", "tu es {{prompt}}"]);
    });
  });

  it("refuse un gabarit sans {{prompt}} : l'agent ne recevrait jamais l'objectif", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "muet", { bin: "muet", args: "exec --json" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/objectif de la tâche/);
      expect((await loadConfig(root)).config.agents).toEqual([]);
    });
  });

  it("refuse un jeton mal orthographié en le nommant", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "faute", { bin: "x", args: "--message {{promt}}" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/\{\{promt\}\}/);
    });
  });

  it("refuse un guillemet non refermé plutôt que d'enregistrer une ligne de commande tronquée", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "x", { bin: "x", args: '--system "tu es {{prompt}}' }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/non refermé/);
    });
  });

  it("signale que le binaire est absent du PATH, sans refuser la déclaration", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "absent", { bin: "binaire-qui-n-existe-pas-caesar", args: "{{prompt}}" }, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/introuvable dans le PATH/);
      expect((await loadConfig(root)).config.agents).toHaveLength(1);
    });
  });

  it("un chemin explicite est vérifié tel quel, et le message n'envoie pas chercher dans le PATH", async () => {
    await withFakeHome(async () => {
      // Chemin absolu vers un exécutable réel : aucun avertissement.
      expect(await runAgentsAdd(root, "reel", { bin: process.execPath, args: "{{prompt}}" }, io)).toBe(EXIT_OK);
      expect(io.stdoutText()).not.toMatch(/introuvable|n'existe pas/);

      // Chemin absolu vers rien : avertissement, mais formulé sur le fichier.
      const io2 = makeIo();
      expect(await runAgentsAdd(root, "fantome", { bin: "/opt/rien/du/tout", args: "{{prompt}}" }, io2)).toBe(EXIT_OK);
      expect(io2.stdoutText()).toMatch(/n'existe pas ou n'est pas exécutable/);
      expect(io2.stdoutText()).not.toMatch(/PATH/);
    });
  });

  it("avertit qu'une déclaration portant un identifiant natif remplace l'adaptateur", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsAdd(root, "codex", { bin: "codex", args: "{{prompt}}" }, io)).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/catalogue natif/);
    });
  });

  it("--read-only-native survit à l'aller-retour, et vaut faux sans l'option", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "ro", { bin: "ro", args: "{{prompt}}", readOnlyNative: true }, io);
      await runAgentsAdd(root, "rw", { bin: "rw", args: "{{prompt}}" }, makeIo());
      const { config } = await loadConfig(root);
      expect(config.agents.find((a) => a.id === "ro")?.capabilities).toEqual({ nativeReadOnly: true });
      expect(config.agents.find((a) => a.id === "rw")).not.toHaveProperty("capabilities");
    });
  });

  it("écrit la couche visée, et elle seule", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "global-only", { bin: "x", args: "{{prompt}}", global: true }, io);
      const { layers } = await loadConfig(root);
      expect(layers.find((l) => l.scope === "global")?.override.agents?.[0]?.id).toBe("global-only");
      expect(layers.find((l) => l.scope === "project")?.override.agents).toBeUndefined();
    });
  });

  it("remplace une déclaration existante de la même couche plutôt que de la doubler", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "a", { bin: "v1", args: "{{prompt}}" }, io);
      await runAgentsAdd(root, "a", { bin: "v2", args: "{{prompt}}" }, makeIo());
      const { config } = await loadConfig(root);
      expect(config.agents).toHaveLength(1);
      expect(config.agents[0]!.bin).toBe("v2");
    });
  });

  it("remove retire la déclaration de la couche qui la porte", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "a", { bin: "x", args: "{{prompt}}" }, io);
      const removeIo = makeIo();
      expect(await runAgentsRemove(root, "a", {}, removeIo)).toBe(EXIT_OK);
      expect((await loadConfig(root)).config.agents).toEqual([]);
    });
  });

  it("remove sur une autre couche refuse et nomme celle qui déclare", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "a", { bin: "x", args: "{{prompt}}", global: true }, io);
      const removeIo = makeIo();
      // La fusion par clé ne sait pas exprimer une suppression : retirer "a"
      // de la couche projet ne le ferait pas disparaître de la fusion.
      expect(await runAgentsRemove(root, "a", {}, removeIo)).toBe(EXIT_USAGE);
      expect(removeIo.stderrText()).toMatch(/--global/);
      expect((await loadConfig(root)).config.agents).toHaveLength(1);
    });
  });

  it("remove sur un agent natif renvoie vers \"agents disable\" plutôt que de faire semblant", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsRemove(root, "codex", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/agents disable codex/);
    });
  });
});

describe("caesar agents test", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-test-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuse un identifiant d'agent inconnu, sans lancer quoi que ce soit", async () => {
    const code = await runAgentsTest(root, "agent-fantome", { yes: true }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/inconnu/);
  });

  it("exige --yes : refuse de lancer une tâche réelle sans confirmation explicite", async () => {
    const code = await runAgentsTest(root, "codex", {}, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/--yes/);
  });

  it("respecte la politique : un agent refusé n'est jamais lancé, même avec --yes", async () => {
    await withFakeHome(async () => {
      await runAgentsDisable(root, "codex", {}, makeIo());
      const code = await runAgentsTest(root, "codex", { yes: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toContain("codex");
      expect(io.stderrText()).toMatch(/denied/);
    });
  });

  it("--yes : aller-retour complet avec un agent factice substitué au vrai binaire", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        // "git init" : `agents test` passe par `runTask`, dont l'isolation "inplace"
        // explicite n'a pas besoin d'un dépôt git, mais un dépôt réel écarte
        // toute ambiguïté sur le comportement observé.
        await execFileAsync("git", ["init", "-q"], { cwd: root });
        await execFileAsync("git", ["config", "user.email", "caesar-test@example.com"], { cwd: root });
        await execFileAsync("git", ["config", "user.name", "Caesar Test"], { cwd: root });

        const code = await runAgentsTest(root, "codex", { yes: true, json: true }, io);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.responded).toBe(true);
        expect(parsed.report_source).toBe("file");
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);
});
