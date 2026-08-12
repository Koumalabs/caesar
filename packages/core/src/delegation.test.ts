import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV } from "@orch/protocol";
import { defaultConfig } from "./config.js";
import type { OrchConfig, RoleConfig } from "./config.js";
import { nextDelegationDepth, resolveDelegation } from "./delegation.js";

function role(overrides: Partial<RoleConfig> = {}): RoleConfig {
  return {
    name: "reviewer",
    purpose: "Relit un diff.",
    agents: ["codex", "antigravity"],
    mode: "read-only",
    isolation: "inplace",
    network: "auto",
    timeout_ms: 600_000,
    ...overrides,
  };
}

describe("resolveDelegation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-delegation-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ni agent ni rôle : refus", async () => {
    const result = await resolveDelegation(defaultConfig(), root, {});
    expect("error" in result).toBe(true);
  });

  it("--agent l'emporte sur le choix issu du rôle", async () => {
    const config: OrchConfig = { ...defaultConfig(), roles: [role()] };
    const result = await resolveDelegation(config, root, { role: "reviewer", agent: "copilot" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.agentId).toBe("copilot");
      // Le rôle reste résolu pour ses valeurs par défaut malgré l'agent explicite.
      expect(result.mode).toBe("read-only");
      expect(result.isolation).toBe("inplace");
      expect(result.role).toBe("reviewer");
    }
  });

  it("rôle inconnu : refus nommant le rôle", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { role: "inexistant" });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/inexistant/);
  });

  it("agent inconnu du catalogue : refus", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "agent-fantome" });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/inconnu/);
  });

  it("agent refusé par la politique : motif exact de checkDelegation", async () => {
    const config: OrchConfig = { ...defaultConfig(), policy: { ...defaultConfig().policy, denied: ["codex"] } };
    const result = await resolveDelegation(config, root, { agent: "codex" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe('Agent "codex" refusé : présent dans la liste "denied" de la politique.');
    }
  });

  it("mode/isolation/timeout explicites l'emportent sur ceux du rôle", async () => {
    const config: OrchConfig = { ...defaultConfig(), roles: [role({ mode: "read-only", isolation: "inplace", timeout_ms: 60_000 })] };
    const result = await resolveDelegation(config, root, { role: "reviewer", agent: "copilot", mode: "write", isolation: "worktree", timeout: "5m" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mode).toBe("write");
      expect(result.isolation).toBe("worktree");
      expect(result.timeoutMs).toBe(5 * 60_000);
    }
  });

  it("aucun mode/isolation fourni : retombe sur les valeurs par défaut de la politique quand il n'y a pas de rôle", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "codex" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mode).toBe(defaultConfig().policy.default_mode);
      expect(result.isolation).toBe(defaultConfig().policy.default_isolation);
      expect(result.timeoutMs).toBe(defaultConfig().policy.default_timeout_ms);
    }
  });

  it("durée invalide : motif de parseDuration, tel quel", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "codex", timeout: "3 fortnights" });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/Durée invalide/);
  });

  it("fusionne le contexte donné avec le prompt système du rôle", async () => {
    await mkdir(join(root, ".orch"), { recursive: true });
    await writeFile(join(root, ".orch", "system.md"), "Tu es un relecteur strict.", "utf8");
    const config: OrchConfig = { ...defaultConfig(), roles: [role({ system_prompt_file: "system.md" })] };

    const result = await resolveDelegation(config, root, { role: "reviewer", agent: "copilot", context: "Contexte additionnel." });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.context).toBe("Tu es un relecteur strict.\n\n---\n\nContexte additionnel.");
    }
  });

  it("aucun rôle, aucun contexte fourni : context absent du résultat", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "codex" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.context).toBeUndefined();
  });

  it("rôle sans agent choisi explicitement : la résolution passe bien par pickAgentForRole (@orch/core)", async () => {
    // PATH réduit à un répertoire vide : aucun agent du catalogue n'y est
    // "installé", quelle que soit la machine de développement — le mécanisme
    // de repli lui-même (ordre des candidats, formulation du motif) est déjà
    // couvert en détail par `roles.test.ts` ; ce test vérifie seulement que
    // `resolveDelegation` délègue bien à `pickAgentForRole` plutôt que de
    // choisir un agent par un autre chemin.
    const emptyPathDir = await mkdtemp(join(tmpdir(), "orch-delegation-emptypath-"));
    const previousPath = process.env["PATH"];
    process.env["PATH"] = emptyPathDir;
    try {
      const config: OrchConfig = { ...defaultConfig(), roles: [role({ agents: ["codex", "antigravity"] })] };
      const result = await resolveDelegation(config, root, { role: "reviewer" });
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("reviewer");
        expect(result.error).toMatch(/non installé/);
      }
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      await rm(emptyPathDir, { recursive: true, force: true });
    }
  });
});

describe("resolveDelegation — réseau", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-network-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuse — sans rien écrire sur le disque — un « on » que codex ne peut pas honorer en lecture seule", async () => {
    // Le cas qui a motivé le chantier. Le refus tombe avant toute création de
    // répertoire de tâche : c'est ce que la position de `decideNetwork` dans
    // `resolveDelegation`, juste après `checkDelegation`, garantit.
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "read-only",
      network: "on",
      depth: 0,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("attendu un refus");
    expect(result.error).toContain("codex");
    expect(result.error).toContain("--mode write");
    expect(await readdir(root)).toEqual([]);
  });

  it("accorde le même « on » dès que le mode passe en écriture", async () => {
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "write",
      network: "on",
      depth: 0,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(true);
    expect(result.networkWarning).toBeUndefined();
  });

  it("sous « auto », une tâche codex en lecture seule part quand même — mais avec un avertissement", async () => {
    // Sans cette nuance entre `auto` et `on`, les rôles `reviewer` et
    // `investigator` livrés par défaut seraient tous deux hors service.
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "read-only",
      depth: 0,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(false);
    expect(result.networkWarning).toContain("Réseau indisponible");
  });

  it("hérite du rôle, puis de la politique", async () => {
    const config: OrchConfig = { ...defaultConfig(), roles: [role({ agents: ["codex"], network: "on" })] };
    const parRole = await resolveDelegation(config, root, { role: "reviewer", mode: "write", depth: 0 });
    if ("error" in parRole) throw new Error(parRole.error);
    expect(parRole.network).toBe(true);

    const parPolitique: OrchConfig = {
      ...defaultConfig(),
      policy: { ...defaultConfig().policy, default_network: "off" },
    };
    const result = await resolveDelegation(parPolitique, root, { agent: "codex", mode: "write", depth: 0 });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(false);
  });

  it("la demande explicite l'emporte sur le rôle", async () => {
    const config: OrchConfig = { ...defaultConfig(), roles: [role({ agents: ["codex"], network: "on" })] };
    const result = await resolveDelegation(config, root, {
      role: "reviewer",
      mode: "write",
      network: "off",
      depth: 0,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(false);
  });

  it("avoue ne pas savoir refermer le réseau d'un agent qu'il ne confine pas", async () => {
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "opencode",
      mode: "write",
      network: "off",
      depth: 0,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(true);
    expect(result.networkWarning).toContain("ne sait pas le refermer");
  });
});

/**
 * Le refus d'écriture en place, vu depuis la première des deux portes.
 *
 * `prepareIsolation` rend le même verdict — c'est le filet que traverse tout
 * appel direct à `runTask` — mais après avoir créé le répertoire de tâche.
 * Ici, un refus ne laisse rien derrière lui : c'est ce que le dernier test de
 * ce bloc vérifie, et c'est la raison d'être de cette porte-ci.
 */
describe("resolveDelegation — écriture en place", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-delegation-inplace-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function initGitRepo(dir: string): Promise<void> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: dir });
    await run("git", ["config", "user.email", "orch-test@example.com"], { cwd: dir });
    await run("git", ["config", "user.name", "Orch Test"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    await run("git", ["add", "a.txt"], { cwd: dir });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  }

  it('refuse "inplace" + write dans un dépôt utilisable, en nommant la provenance explicite', async () => {
    await initGitRepo(root);
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "write",
      isolation: "inplace",
      depth: 0,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/demandée explicitement/);
      expect(result.error).toMatch(/allow_inplace_write/);
    }
  });

  it("nomme le rôle quand l'isolation en vient, plutôt que la demande", async () => {
    // Le cas réel : un rôle `implementer` mal configuré en `inplace`. Un motif
    // disant « demandée explicitement » enverrait corriger le mauvais endroit.
    await initGitRepo(root);
    const config: OrchConfig = {
      ...defaultConfig(),
      roles: [role({ name: "implementer", mode: "write", isolation: "inplace" })],
    };
    const result = await resolveDelegation(config, root, { role: "implementer", agent: "codex", depth: 0 });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/rôle "implementer"/);
  });

  it("nomme la politique quand l'isolation vient de son défaut", async () => {
    await initGitRepo(root);
    const config: OrchConfig = {
      ...defaultConfig(),
      policy: { ...defaultConfig().policy, default_isolation: "inplace" },
    };
    const result = await resolveDelegation(config, root, { agent: "codex", mode: "write", depth: 0 });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/default_isolation/);
  });

  it("accepte sous opt-in, et rend la permission à transmettre au moteur", async () => {
    await initGitRepo(root);
    const config: OrchConfig = {
      ...defaultConfig(),
      policy: { ...defaultConfig().policy, allow_inplace_write: true },
    };
    const result = await resolveDelegation(config, root, {
      agent: "codex",
      mode: "write",
      isolation: "inplace",
      depth: 0,
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.isolation).toBe("inplace");
      // Sans cette transmission, `prepareIsolation` refuserait ce que
      // `resolveDelegation` vient d'accorder — le défaut par défaut fermé
      // n'a de sens que si la permission voyage.
      expect(result.allowInplaceWrite).toBe(true);
    }
  });

  it("accepte hors dépôt git : aucun worktree n'y serait possible", async () => {
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "write",
      isolation: "inplace",
      depth: 0,
    });
    expect("error" in result).toBe(false);
  });

  it("refuse sans rien écrire sur le disque", async () => {
    // Même promesse que le refus réseau, qui précède déjà toute écriture :
    // une délégation refusée ne doit pas laisser de répertoire de tâche.
    await initGitRepo(root);
    const before = await readdir(root);
    await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "write",
      isolation: "inplace",
      depth: 0,
    });
    expect(await readdir(root)).toEqual(before);
  });
});

/**
 * `nextDelegationDepth` — voir C4 de la revue finale : `$ORCH_DEPTH` était
 * bien exporté vers les sous-processus (`taskEnv`, `@orch/protocol`) mais
 * jamais relu par personne, ce qui rendait `max_depth` inapplicable dès
 * qu'un agent délégant tournait lui-même comme sous-agent. Testée
 * directement plutôt que via l'environnement réel du process de test (voir
 * les tests d'intégration de `run.test.ts`, `@orch/cli`, qui couvrent le
 * câblage bout en bout) : ici, seule la fonction de calcul.
 */
describe("nextDelegationDepth", () => {
  it("aucune variable héritée : profondeur 1 (premier niveau de délégation)", () => {
    expect(nextDelegationDepth({})).toBe(1);
  });

  it("profondeur héritée n : rend n + 1", () => {
    expect(nextDelegationDepth({ [ENV.depth]: "3" })).toBe(4);
  });

  it("valeur non numérique héritée : retombe sur 0 avant d'ajouter 1, plutôt que NaN", () => {
    // Un NaN propagé jusqu'à `isDepthAllowed` (`depth >= max_depth`) serait
    // toujours faux : le garde-fou anti-récursion se désarmerait en
    // silence sur la moindre variable malformée. Vérifié explicitement.
    expect(nextDelegationDepth({ [ENV.depth]: "pas-un-nombre" })).toBe(1);
    expect(Number.isNaN(nextDelegationDepth({ [ENV.depth]: "pas-un-nombre" }))).toBe(false);
  });
});
