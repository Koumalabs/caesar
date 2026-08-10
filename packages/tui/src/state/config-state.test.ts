/**
 * Tests de `config-state.ts` — le cœur du TUI, sans aucun rendu. Sous
 * `bun test` (voir `packages/tui/package.json`, script "test") : c'est le
 * seul runtime dont ce package dépend, et ces tests sont du TypeScript pur,
 * sans OpenTUI.
 *
 * Aucune configuration réelle de l'utilisateur n'est touchée : chaque test
 * qui a besoin du disque passe par un répertoire temporaire dédié
 * (`mkdtemp`) et neutralise `HOME` — même garde-fou que
 * `packages/core/src/config.test.ts` et `packages/cli/test/support.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleConfig } from "@orch/core";
import { configPathFor, saveLayer } from "@orch/core";
import {
  activeScopePath,
  addRoleAgent,
  effectiveConfig,
  findRole,
  isDirty,
  loadConfigState,
  moveRoleAgent,
  nextScope,
  pickAgentForRoleName,
  policyFieldMark,
  removeRole,
  removeRoleAgentAt,
  roleDeclaredByActiveLayer,
  roleMark,
  saveConfigState,
  setPolicyListEntry,
  setScope,
  toggleAgentDenied,
  updatePolicy,
  updateRole,
  upsertRole,
  type ConfigState,
} from "./config-state";
import { emptyConfigState as emptyState } from "./test-helpers";

/** Exécute `fn` avec `HOME` pointé vers un répertoire temporaire : aucun `~/.config/orch/config.toml` réel n'est lu. */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "orch-tui-home-"));
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

const ROLE: RoleConfig = {
  name: "reviewer-test",
  purpose: "Relit un diff.",
  agents: ["codex", "antigravity", "opencode"],
  mode: "read-only",
  isolation: "inplace",
  timeout_ms: 600_000,
};

describe("isDirty", () => {
  it("faux juste après le chargement, vrai dès la première modification, faux après enregistrement", async () => {
    let root: string;
    await withFakeHome(async () => {
      root = await mkdtemp(join(tmpdir(), "orch-tui-dirty-"));
      try {
        const loaded = await loadConfigState(root);
        expect(isDirty(loaded)).toBe(false);

        const edited = toggleAgentDenied(loaded, "codex");
        expect(isDirty(edited)).toBe(true);

        const saved = await saveConfigState(root, edited);
        expect(isDirty(saved)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("basculer l'autorisation d'un agent", () => {
  it("ajoute puis retire l'agent de la liste \"denied\", sans toucher \"allowed\"", () => {
    const state = emptyState();
    expect(effectiveConfig(state).policy.denied).not.toContain("codex");

    const once = toggleAgentDenied(state, "codex");
    expect(effectiveConfig(once).policy.denied).toContain("codex");

    const twice = toggleAgentDenied(once, "codex");
    expect(effectiveConfig(twice).policy.denied).not.toContain("codex");
    // La copie de travail d'origine reste intacte (mutation pure).
    expect(effectiveConfig(state).policy.denied).not.toContain("codex");
  });
});

describe("réordonner les agents d'un rôle", () => {
  function stateWithRole(): ConfigState {
    return upsertRole(emptyState(), ROLE);
  }

  it("déplace un agent vers le haut puis vers le bas", () => {
    const state = stateWithRole();
    expect(findRole(state, ROLE.name)?.agents).toEqual(["codex", "antigravity", "opencode"]);

    const up = moveRoleAgent(state, ROLE.name, 1, "up");
    expect(findRole(up, ROLE.name)?.agents).toEqual(["antigravity", "codex", "opencode"]);

    const down = moveRoleAgent(up, ROLE.name, 0, "down");
    expect(findRole(down, ROLE.name)?.agents).toEqual(["codex", "antigravity", "opencode"]);
  });

  it("ne fait rien si le déplacement sortirait de la liste", () => {
    const state = stateWithRole();
    const first = moveRoleAgent(state, ROLE.name, 0, "up");
    expect(findRole(first, ROLE.name)?.agents).toEqual(ROLE.agents);

    const last = moveRoleAgent(state, ROLE.name, 2, "down");
    expect(findRole(last, ROLE.name)?.agents).toEqual(ROLE.agents);
  });

  it("ajoute un agent absent de la liste, ignore un agent déjà présent", () => {
    const state = stateWithRole();
    const added = addRoleAgent(state, ROLE.name, "claude");
    expect(findRole(added, ROLE.name)?.agents).toEqual(["codex", "antigravity", "opencode", "claude"]);

    const unchanged = addRoleAgent(added, ROLE.name, "claude");
    expect(findRole(unchanged, ROLE.name)?.agents).toEqual(findRole(added, ROLE.name)?.agents);
  });

  it("retire un agent par position", () => {
    const state = stateWithRole();
    const removed = removeRoleAgentAt(state, ROLE.name, 1);
    expect(findRole(removed, ROLE.name)?.agents).toEqual(["codex", "opencode"]);
  });
});

describe("créer et supprimer un rôle", () => {
  it("upsertRole crée un rôle nouveau, puis le remplace entièrement s'il existe déjà", () => {
    const state = emptyState();
    const created = upsertRole(state, ROLE);
    expect(findRole(created, ROLE.name)).toEqual(ROLE);
    expect(effectiveConfig(created).roles.length).toBe(effectiveConfig(state).roles.length + 1);

    const replaced = upsertRole(created, { ...ROLE, purpose: "Nouvelle intention." });
    expect(effectiveConfig(replaced).roles.length).toBe(effectiveConfig(created).roles.length);
    expect(findRole(replaced, ROLE.name)?.purpose).toBe("Nouvelle intention.");
  });

  it("removeRole retire le rôle et lui seul, quand la couche active le déclare", () => {
    const state = emptyState();
    const withRole = upsertRole(state, ROLE);
    const countBefore = effectiveConfig(withRole).roles.length;

    expect(roleDeclaredByActiveLayer(withRole, ROLE.name)).toBe(true);
    const removed = removeRole(withRole, ROLE.name);
    expect(findRole(removed, ROLE.name)).toBeUndefined();
    expect(effectiveConfig(removed).roles.length).toBe(countBefore - 1);
  });

  it("removeRole n'a aucun effet sur un rôle hérité (pas déclaré par la couche active)", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-role-inherited-"));
      try {
        await saveLayer("global", root, { roles: [ROLE] });
        const state = await loadConfigState(root); // activeScope "project" par défaut

        expect(roleDeclaredByActiveLayer(state, ROLE.name)).toBe(false);
        expect(findRole(state, ROLE.name)).toEqual(ROLE); // hérité, visible dans la fusion effective

        const attempted = removeRole(state, ROLE.name);
        expect(findRole(attempted, ROLE.name)).toEqual(ROLE); // toujours là : rien n'a bougé
        expect(isDirty(attempted)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("updateRole modifie un champ sans toucher aux autres", () => {
    const state = upsertRole(emptyState(), ROLE);
    const updated = updateRole(state, ROLE.name, { mode: "write", timeout_ms: 120_000 });
    const role = findRole(updated, ROLE.name)!;
    expect(role.mode).toBe("write");
    expect(role.timeout_ms).toBe(120_000);
    expect(role.agents).toEqual(ROLE.agents);
    expect(role.purpose).toBe(ROLE.purpose);
  });
});

describe("modifier la politique", () => {
  it("updatePolicy fusionne les champs donnés sans toucher aux autres", () => {
    const state = emptyState();
    const updated = updatePolicy(state, { max_parallel: 8, allow_recursion: true });
    expect(effectiveConfig(updated).policy.max_parallel).toBe(8);
    expect(effectiveConfig(updated).policy.allow_recursion).toBe(true);
    expect(effectiveConfig(updated).policy.default_mode).toBe(effectiveConfig(state).policy.default_mode);
  });

  it("setPolicyListEntry : \"denied\" l'emporte, mais ce module ne fait qu'ajouter/retirer — la règle reste dans @orch/core", () => {
    const state = emptyState();
    const withAllowed = setPolicyListEntry(state, "allowed", "codex", true);
    expect(effectiveConfig(withAllowed).policy.allowed).toContain("codex");

    const withoutAllowed = setPolicyListEntry(withAllowed, "allowed", "codex", false);
    expect(effectiveConfig(withoutAllowed).policy.allowed).not.toContain("codex");

    const withDenied = setPolicyListEntry(state, "denied", "codex", true);
    expect(effectiveConfig(withDenied).policy.denied).toContain("codex");
  });

  it("matérialise la liste effective (héritée comprise), pas seulement l'id ajouté — même règle que materializePolicyList", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-materialize-"));
      try {
        await saveLayer("global", root, { policy: { denied: ["copilot"] } });
        const state = await loadConfigState(root); // activeScope "project"

        const edited = setPolicyListEntry(state, "denied", "opencode", true);
        // La couche projet porte désormais la liste effective entière ("copilot" hérité + "opencode"),
        // jamais "opencode" seul — sans quoi le refus hérité de "copilot" disparaîtrait du disque.
        expect(edited.draft.policy?.denied).toEqual(["copilot", "opencode"]);
        expect(effectiveConfig(edited).policy.denied).toEqual(["copilot", "opencode"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("aller-retour save/load", () => {
  it("saveConfigState puis loadConfigState rendent exactement ce qui a été modifié", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-roundtrip-"));
      try {
        const state = await loadConfigState(root);
        let edited = toggleAgentDenied(state, "codex");
        edited = updatePolicy(edited, { max_parallel: 9 });
        edited = upsertRole(edited, ROLE);

        await saveConfigState(root, edited);

        const reloaded = await loadConfigState(root);
        expect(effectiveConfig(reloaded).policy.denied).toContain("codex");
        expect(effectiveConfig(reloaded).policy.max_parallel).toBe(9);
        expect(findRole(reloaded, ROLE.name)).toEqual(ROLE);
        // Un rechargement frais n'a plus de modification en attente.
        expect(isDirty(reloaded)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("pickAgentForRoleName", () => {
  it("retient le premier agent installé et autorisé, dans l'ordre du rôle", () => {
    const state = upsertRole(emptyState(), ROLE);
    const installed = new Map([
      ["codex", false],
      ["antigravity", true],
      ["opencode", true],
    ]);
    const pick = pickAgentForRoleName(state, ROLE.name, installed);
    expect(pick && "agentId" in pick ? pick.agentId : undefined).toBe("antigravity");
  });

  it("bascule sur le second choix si le premier est refusé par la politique (\"denied\")", () => {
    let state = upsertRole(emptyState(), ROLE);
    state = setPolicyListEntry(state, "denied", "codex", true);
    const installed = new Map([
      ["codex", true],
      ["antigravity", true],
      ["opencode", true],
    ]);
    const pick = pickAgentForRoleName(state, ROLE.name, installed);
    expect(pick && "agentId" in pick ? pick.agentId : undefined).toBe("antigravity");
  });

  it("renvoie null pour un rôle inconnu", () => {
    expect(pickAgentForRoleName(emptyState(), "rôle-fantôme", new Map())).toBeNull();
  });
});

describe("portée d'édition", () => {
  it("loadConfigState porte la portée \"project\" par défaut", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-scope-default-"));
      try {
        const state = await loadConfigState(root);
        expect(state.activeScope).toBe("project");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("nextScope cycle global → projet → local → global", () => {
    expect(nextScope("global")).toBe("project");
    expect(nextScope("project")).toBe("local");
    expect(nextScope("local")).toBe("global");
  });

  it("setScope repart de la dernière version enregistrée de la nouvelle couche, jamais du draft de l'ancienne", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-scope-switch-"));
      try {
        await saveLayer("global", root, { policy: { max_parallel: 5 } });
        const state = await loadConfigState(root); // "project"
        const edited = updatePolicy(state, { max_parallel: 42 }); // modification en attente sur "project"
        expect(isDirty(edited)).toBe(true);

        const onGlobal = setScope(edited, "global");
        expect(onGlobal.activeScope).toBe("global");
        // Repart du disque pour "global" (max_parallel=5), pas de "42" qui appartenait au draft "project".
        expect(onGlobal.draft.policy?.max_parallel).toBe(5);
        expect(isDirty(onGlobal)).toBe(false);

        // Revenir sur "project" retrouve bien sa dernière version *enregistrée* (vide ici, jamais sauvegardée) —
        // la modification à 42 n'a jamais été enregistrée, elle est donc bien perdue, comme prévu par le
        // changement de portée explicite (confirmé par l'appelant, voir `App.tsx`).
        const backToProject = setScope(onGlobal, "project");
        expect(backToProject.draft.policy?.max_parallel).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("marques d'héritage", () => {
    it("policyFieldMark signale une couche moins spécifique que la couche active, jamais la couche active elle-même", async () => {
      await withFakeHome(async () => {
        const root = await mkdtemp(join(tmpdir(), "orch-tui-mark-policy-"));
        try {
          await saveLayer("global", root, { policy: { max_parallel: 9 } });
          const state = await loadConfigState(root); // "project" : n'a pas encore surchargé max_parallel

          expect(policyFieldMark(state, "max_parallel")).toBe("global");
          expect(policyFieldMark(state, "allow_recursion")).toBe("default"); // jamais déclaré nulle part

          // Sur la couche global elle-même, plus rien à surcharger pour ce champ : pas de marque.
          const onGlobal = setScope(state, "global");
          expect(policyFieldMark(onGlobal, "max_parallel")).toBeNull();

          // Une fois que "project" déclare le champ à son tour, la marque disparaît.
          const overridden = updatePolicy(state, { max_parallel: 3 });
          expect(policyFieldMark(overridden, "max_parallel")).toBeNull();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    });

    it("roleMark et roleDeclaredByActiveLayer reflètent la provenance d'un rôle", async () => {
      await withFakeHome(async () => {
        const root = await mkdtemp(join(tmpdir(), "orch-tui-mark-role-"));
        try {
          await saveLayer("global", root, { roles: [ROLE] });
          const state = await loadConfigState(root); // "project"

          expect(roleMark(state, ROLE.name)).toBe("global");
          expect(roleDeclaredByActiveLayer(state, ROLE.name)).toBe(false);

          const onGlobal = setScope(state, "global");
          expect(roleMark(onGlobal, ROLE.name)).toBeNull();
          expect(roleDeclaredByActiveLayer(onGlobal, ROLE.name)).toBe(true);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    });
  });

  it("le scénario qui compte : enregistrer en portée globale depuis un projet ne touche que le fichier global", async () => {
    await withFakeHome(async (home) => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-scope-global-save-"));
      try {
        const projectPath = configPathFor("project", root);
        const globalPath = configPathFor("global", root);
        expect(globalPath.startsWith(home)).toBe(true); // s'assure qu'on vise bien le HOME neutralisé, pas le vrai

        let state = await loadConfigState(root); // "project" par défaut, comme le TUI au démarrage
        state = setScope(state, "global"); // bascule explicite de portée (la touche "p")
        state = updatePolicy(state, { max_parallel: 7 }); // une modification, en attente sur "global"
        expect(isDirty(state)).toBe(true);

        await saveConfigState(root, state); // "s" : n'enregistre que la couche active

        // Le fichier global a changé...
        const globalContent = await readFile(globalPath, "utf8");
        expect(globalContent).toContain("max_parallel");
        expect(globalContent).toContain("7");

        // ...et le fichier projet n'a jamais été créé (aucune écriture n'a touché la couche projet).
        await expect(readFile(projectPath, "utf8")).rejects.toThrow();

        const reloaded = await loadConfigState(root, "project");
        expect(effectiveConfig(reloaded).policy.max_parallel).toBe(7); // le projet hérite bien du global
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
