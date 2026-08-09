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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleConfig } from "@orch/core";
import {
  addRoleAgent,
  findRole,
  isDirty,
  loadConfigState,
  moveRoleAgent,
  pickAgentForRoleName,
  removeRole,
  removeRoleAgentAt,
  saveConfigState,
  setPolicyListEntry,
  toggleAgentDenied,
  updatePolicy,
  updateRole,
  upsertRole,
  type ConfigState,
} from "./config-state";

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
  it("ajoute puis retire l'agent de la liste \"denied\", sans toucher \"allowed\"", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-toggle-"));
      try {
        const state = await loadConfigState(root);
        expect(state.draft.policy.denied).not.toContain("codex");

        const once = toggleAgentDenied(state, "codex");
        expect(once.draft.policy.denied).toContain("codex");

        const twice = toggleAgentDenied(once, "codex");
        expect(twice.draft.policy.denied).not.toContain("codex");
        // `saved` (baseline) reste intact tant que rien n'est enregistré.
        expect(state.saved.policy.denied).not.toContain("codex");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("réordonner les agents d'un rôle", () => {
  function stateWithRole(): ConfigState {
    const base: ConfigState = {
      saved: { policy: { allowed: [], denied: [], max_parallel: 4, default_isolation: "auto", default_mode: "write", default_timeout_ms: 600_000, allow_recursion: false, max_depth: 2 }, roles: [], agents: [] },
      draft: { policy: { allowed: [], denied: [], max_parallel: 4, default_isolation: "auto", default_mode: "write", default_timeout_ms: 600_000, allow_recursion: false, max_depth: 2 }, roles: [], agents: [] },
      sources: {},
    };
    return upsertRole(base, ROLE);
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
  it("upsertRole crée un rôle nouveau, puis le remplace entièrement s'il existe déjà", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-role-crud-"));
      try {
        const state = await loadConfigState(root);
        const created = upsertRole(state, ROLE);
        expect(findRole(created, ROLE.name)).toEqual(ROLE);
        expect(created.draft.roles.length).toBe(state.draft.roles.length + 1);

        const replaced = upsertRole(created, { ...ROLE, purpose: "Nouvelle intention." });
        expect(replaced.draft.roles.length).toBe(created.draft.roles.length);
        expect(findRole(replaced, ROLE.name)?.purpose).toBe("Nouvelle intention.");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("removeRole retire le rôle et lui seul", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-role-remove-"));
      try {
        const state = await loadConfigState(root);
        const withRole = upsertRole(state, ROLE);
        const countBefore = withRole.draft.roles.length;

        const removed = removeRole(withRole, ROLE.name);
        expect(findRole(removed, ROLE.name)).toBeUndefined();
        expect(removed.draft.roles.length).toBe(countBefore - 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("updateRole modifie un champ sans toucher aux autres", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-role-update-"));
      try {
        const state = upsertRole(await loadConfigState(root), ROLE);
        const updated = updateRole(state, ROLE.name, { mode: "write", timeout_ms: 120_000 });
        const role = findRole(updated, ROLE.name)!;
        expect(role.mode).toBe("write");
        expect(role.timeout_ms).toBe(120_000);
        expect(role.agents).toEqual(ROLE.agents);
        expect(role.purpose).toBe(ROLE.purpose);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("modifier la politique", () => {
  it("updatePolicy fusionne les champs donnés sans toucher aux autres", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-policy-"));
      try {
        const state = await loadConfigState(root);
        const updated = updatePolicy(state, { max_parallel: 8, allow_recursion: true });
        expect(updated.draft.policy.max_parallel).toBe(8);
        expect(updated.draft.policy.allow_recursion).toBe(true);
        expect(updated.draft.policy.default_mode).toBe(state.draft.policy.default_mode);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("setPolicyListEntry : \"denied\" l'emporte, mais ce module ne fait qu'ajouter/retirer — la règle reste dans @orch/core", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-policy-lists-"));
      try {
        const state = await loadConfigState(root);
        const withAllowed = setPolicyListEntry(state, "allowed", "codex", true);
        expect(withAllowed.draft.policy.allowed).toContain("codex");

        const withoutAllowed = setPolicyListEntry(withAllowed, "allowed", "codex", false);
        expect(withoutAllowed.draft.policy.allowed).not.toContain("codex");

        const withDenied = setPolicyListEntry(state, "denied", "codex", true);
        expect(withDenied.draft.policy.denied).toContain("codex");
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
        expect(reloaded.draft.policy.denied).toContain("codex");
        expect(reloaded.draft.policy.max_parallel).toBe(9);
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
  it("retient le premier agent installé et autorisé, dans l'ordre du rôle", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-pick-"));
      try {
        const state = upsertRole(await loadConfigState(root), ROLE);
        const installed = new Map([
          ["codex", false],
          ["antigravity", true],
          ["opencode", true],
        ]);
        const pick = pickAgentForRoleName(state, ROLE.name, installed);
        expect(pick && "agentId" in pick ? pick.agentId : undefined).toBe("antigravity");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("bascule sur le second choix si le premier est refusé par la politique (\"denied\")", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-pick-denied-"));
      try {
        let state = upsertRole(await loadConfigState(root), ROLE);
        state = setPolicyListEntry(state, "denied", "codex", true);
        const installed = new Map([
          ["codex", true],
          ["antigravity", true],
          ["opencode", true],
        ]);
        const pick = pickAgentForRoleName(state, ROLE.name, installed);
        expect(pick && "agentId" in pick ? pick.agentId : undefined).toBe("antigravity");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("renvoie null pour un rôle inconnu", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-tui-pick-unknown-"));
      try {
        const state = await loadConfigState(root);
        expect(pickAgentForRoleName(state, "rôle-fantôme", new Map())).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
