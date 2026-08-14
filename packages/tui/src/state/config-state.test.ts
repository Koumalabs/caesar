/**
 * Tests for `config-state.ts` — the heart of the TUI, with no rendering.
 * Under `bun test` (see `packages/tui/package.json`, "test" script): it is
 * the only runtime this package depends on, and these tests are pure
 * TypeScript, without OpenTUI.
 *
 * No real user configuration is ever touched: every test that needs the
 * disk goes through a dedicated temporary directory (`mkdtemp`) and
 * neutralizes `HOME` — same safeguard as
 * `packages/core/src/config.test.ts` and `packages/cli/test/support.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenericAgentSpec, RoleConfig } from "@caesar/core";
import { configPathFor, listAgentDefinitions, saveLayer } from "@caesar/core";
import {
  activeScopePath,
  addRoleAgent,
  agentDeclaredByActiveLayer,
  agentMark,
  effectiveConfig,
  findAgentSpec,
  findRole,
  removeAgentSpec,
  updateAgentSpec,
  upsertAgentSpec,
  isDirty,
  loadConfigState,
  modelDeclaredByActiveLayer,
  modelMark,
  moveRoleAgent,
  nextScope,
  pickAgentForRoleName,
  policyFieldMark,
  removeRole,
  removeRoleAgentAt,
  renameRole,
  roleDeclaredByActiveLayer,
  roleMark,
  saveConfigState,
  setPolicyListEntry,
  setScope,
  toggleAgentDenied,
  updateModel,
  updatePolicy,
  updateRole,
  upsertRole,
  type ConfigState,
} from "./config-state";
import { NETWORK_OPTIONS, cycle } from "../screens/shared";
import { emptyConfigState as emptyState } from "./test-helpers";

/** Runs `fn` with `HOME` pointed at a temporary directory: no real `~/.config/caesar/config.toml` is read. */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "caesar-tui-home-"));
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
  purpose: "Reviews a diff.",
  agents: ["codex", "antigravity", "opencode"],
  mode: "read-only",
  isolation: "inplace",
  network: "auto",
  timeout_ms: 600_000,
};

describe("isDirty", () => {
  it("false right after loading, true from the first modification, false after saving", async () => {
    let root: string;
    await withFakeHome(async () => {
      root = await mkdtemp(join(tmpdir(), "caesar-tui-dirty-"));
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

describe("default model per agent ([models])", () => {
  it("updateModel writes only that key into the draft, visible in the effective merge", () => {
    const state = emptyState();
    const edited = updateModel(state, "codex", "gpt-5.2");

    expect(effectiveConfig(edited).models).toEqual({ codex: "gpt-5.2" });
    expect(edited.draft.models).toEqual({ codex: "gpt-5.2" });
    // The original working copy stays intact (pure mutation).
    expect(effectiveConfig(state).models).toEqual({});
  });

  it("updateModel(..., undefined) removes the key; an emptied table leaves the draft entirely", () => {
    let state = updateModel(emptyState(), "codex", "a");
    state = updateModel(state, "claude", "b");

    state = updateModel(state, "codex", undefined);
    expect(state.draft.models).toEqual({ claude: "b" });

    state = updateModel(state, "claude", undefined);
    expect(state.draft.models).toBeUndefined();
  });

  it("removing the active layer's key lets an inherited value reappear — the limit to explain on screen", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-model-inherit-"));
      try {
        await saveLayer("global", root, { models: { codex: "from-global" } });
        let state = await loadConfigState(root); // "project"

        state = updateModel(state, "codex", "override");
        expect(effectiveConfig(state).models["codex"]).toBe("override");

        state = updateModel(state, "codex", undefined);
        expect(effectiveConfig(state).models["codex"]).toBe("from-global");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("modelMark and modelDeclaredByActiveLayer follow the key's provenance, per key", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-model-mark-"));
      try {
        await saveLayer("global", root, { models: { codex: "a" } });
        const state = await loadConfigState(root); // "project"

        expect(modelMark(state, "codex")).toBe("global");
        expect(modelDeclaredByActiveLayer(state, "codex")).toBe(false);
        // No declaration anywhere: "default", like policyFieldMark.
        expect(modelMark(state, "claude")).toBe("default");

        const declared = updateModel(state, "codex", "b");
        expect(modelMark(declared, "codex")).toBeNull();
        expect(modelDeclaredByActiveLayer(declared, "codex")).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("survives the save/reload round-trip on the active layer", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-model-roundtrip-"));
      try {
        let state = await loadConfigState(root);
        state = updateModel(state, "codex", "gpt-5.2");
        await saveConfigState(root, state);

        const reloaded = await loadConfigState(root);
        expect(reloaded.draft.models).toEqual({ codex: "gpt-5.2" });
        expect(effectiveConfig(reloaded).models["codex"]).toBe("gpt-5.2");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("toggling an agent's permission", () => {
  it("adds then removes the agent from the \"denied\" list, without touching \"allowed\"", () => {
    const state = emptyState();
    expect(effectiveConfig(state).policy.denied).not.toContain("codex");

    const once = toggleAgentDenied(state, "codex");
    expect(effectiveConfig(once).policy.denied).toContain("codex");

    const twice = toggleAgentDenied(once, "codex");
    expect(effectiveConfig(twice).policy.denied).not.toContain("codex");
    // The original working copy stays intact (pure mutation).
    expect(effectiveConfig(state).policy.denied).not.toContain("codex");
  });
});

describe("reordering a role's agents", () => {
  function stateWithRole(): ConfigState {
    return upsertRole(emptyState(), ROLE);
  }

  it("moves an agent up then down", () => {
    const state = stateWithRole();
    expect(findRole(state, ROLE.name)?.agents).toEqual(["codex", "antigravity", "opencode"]);

    const up = moveRoleAgent(state, ROLE.name, 1, "up");
    expect(findRole(up, ROLE.name)?.agents).toEqual(["antigravity", "codex", "opencode"]);

    const down = moveRoleAgent(up, ROLE.name, 0, "down");
    expect(findRole(down, ROLE.name)?.agents).toEqual(["codex", "antigravity", "opencode"]);
  });

  it("does nothing if the move would leave the list", () => {
    const state = stateWithRole();
    const first = moveRoleAgent(state, ROLE.name, 0, "up");
    expect(findRole(first, ROLE.name)?.agents).toEqual(ROLE.agents);

    const last = moveRoleAgent(state, ROLE.name, 2, "down");
    expect(findRole(last, ROLE.name)?.agents).toEqual(ROLE.agents);
  });

  it("adds an agent absent from the list, ignores an agent already present", () => {
    const state = stateWithRole();
    const added = addRoleAgent(state, ROLE.name, "claude");
    expect(findRole(added, ROLE.name)?.agents).toEqual(["codex", "antigravity", "opencode", "claude"]);

    const unchanged = addRoleAgent(added, ROLE.name, "claude");
    expect(findRole(unchanged, ROLE.name)?.agents).toEqual(findRole(added, ROLE.name)?.agents);
  });

  it("removes an agent by position", () => {
    const state = stateWithRole();
    const removed = removeRoleAgentAt(state, ROLE.name, 1);
    expect(findRole(removed, ROLE.name)?.agents).toEqual(["codex", "opencode"]);
  });
});

describe("creating and deleting a role", () => {
  it("upsertRole creates a new role, then replaces it entirely if it already exists", () => {
    const state = emptyState();
    const created = upsertRole(state, ROLE);
    expect(findRole(created, ROLE.name)).toEqual(ROLE);
    expect(effectiveConfig(created).roles.length).toBe(effectiveConfig(state).roles.length + 1);

    const replaced = upsertRole(created, { ...ROLE, purpose: "New purpose." });
    expect(effectiveConfig(replaced).roles.length).toBe(effectiveConfig(created).roles.length);
    expect(findRole(replaced, ROLE.name)?.purpose).toBe("New purpose.");
  });

  it("removeRole removes the role and it alone, when the active layer declares it", () => {
    const state = emptyState();
    const withRole = upsertRole(state, ROLE);
    const countBefore = effectiveConfig(withRole).roles.length;

    expect(roleDeclaredByActiveLayer(withRole, ROLE.name)).toBe(true);
    const removed = removeRole(withRole, ROLE.name);
    expect(findRole(removed, ROLE.name)).toBeUndefined();
    expect(effectiveConfig(removed).roles.length).toBe(countBefore - 1);
  });

  it("removeRole has no effect on an inherited role (not declared by the active layer)", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-role-inherited-"));
      try {
        await saveLayer("global", root, { roles: [ROLE] });
        const state = await loadConfigState(root); // activeScope "project" by default

        expect(roleDeclaredByActiveLayer(state, ROLE.name)).toBe(false);
        expect(findRole(state, ROLE.name)).toEqual(ROLE); // inherited, visible in the effective merge

        const attempted = removeRole(state, ROLE.name);
        expect(findRole(attempted, ROLE.name)).toEqual(ROLE); // still there: nothing moved
        expect(isDirty(attempted)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("renameRole changes the name while keeping everything else about the role", () => {
    const state = upsertRole(emptyState(), ROLE);
    const renamed = renameRole(state, ROLE.name, "proofreader");

    expect(findRole(renamed, ROLE.name)).toBeUndefined();
    expect(findRole(renamed, "proofreader")).toEqual({ ...ROLE, name: "proofreader" });
    expect(effectiveConfig(renamed).roles.length).toBe(effectiveConfig(state).roles.length);
  });

  it("renameRole has no effect on an inherited role — otherwise the old name would survive in the layer below", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-role-rename-"));
      try {
        await saveLayer("global", root, { roles: [ROLE] });
        const state = await loadConfigState(root); // active layer "project"

        const attempted = renameRole(state, ROLE.name, "proofreader");
        // Renaming here would not have *moved* the role: a second one would
        // have appeared, the old one continuing to exist, inherited from
        // global.
        expect(findRole(attempted, ROLE.name)).toEqual(ROLE);
        expect(findRole(attempted, "proofreader")).toBeUndefined();
        expect(isDirty(attempted)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("updateRole modifies one field without touching the others", () => {
    const state = upsertRole(emptyState(), ROLE);
    const updated = updateRole(state, ROLE.name, { mode: "write", timeout_ms: 120_000 });
    const role = findRole(updated, ROLE.name)!;
    expect(role.mode).toBe("write");
    expect(role.timeout_ms).toBe(120_000);
    expect(role.agents).toEqual(ROLE.agents);
    expect(role.purpose).toBe(ROLE.purpose);
  });
});

describe("declaring and removing an agent", () => {
  const SPEC: GenericAgentSpec = { id: "aider", bin: "aider", args: ["--message", "{{prompt}}"], cwdMode: "process" };

  it("upsertAgentSpec adds the agent to the effective catalog, without touching the native catalog", () => {
    const state = emptyState();
    const declared = upsertAgentSpec(state, SPEC);

    expect(findAgentSpec(declared, "aider")).toEqual(SPEC);
    const ids = listAgentDefinitions(effectiveConfig(declared).agents).map((def) => def.id);
    expect(ids).toContain("aider");
    expect(ids).toContain("codex"); // the native ones remain
    expect(agentDeclaredByActiveLayer(declared, "aider")).toBe(true);
  });

  it("upsertAgentSpec replaces the existing entry rather than doubling it", () => {
    const state = upsertAgentSpec(emptyState(), SPEC);
    const replaced = upsertAgentSpec(state, { ...SPEC, bin: "/opt/aider" });
    expect(effectiveConfig(replaced).agents).toHaveLength(1);
    expect(findAgentSpec(replaced, "aider")?.bin).toBe("/opt/aider");
  });

  it("updateAgentSpec modifies one field without touching the others, and ignores a native agent", () => {
    const state = upsertAgentSpec(emptyState(), SPEC);
    const updated = updateAgentSpec(state, "aider", { cwdMode: "flag" });
    expect(findAgentSpec(updated, "aider")).toEqual({ ...SPEC, cwdMode: "flag" });

    // "codex" is wired into the registry: no `[[agent]]` entry to modify.
    expect(updateAgentSpec(state, "codex", { bin: "other" })).toBe(state);
  });

  it("removeAgentSpec removes the declaration when the active layer carries it", () => {
    const state = upsertAgentSpec(emptyState(), SPEC);
    const removed = removeAgentSpec(state, "aider");
    expect(findAgentSpec(removed, "aider")).toBeUndefined();
    expect(listAgentDefinitions(effectiveConfig(removed).agents).map((d) => d.id)).not.toContain("aider");
  });

  it("removeAgentSpec has no effect on an inherited declaration, and the mark says so", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-agent-inherited-"));
      try {
        await saveLayer("global", root, { agents: [SPEC] });
        const state = await loadConfigState(root); // activeScope "project" by default

        expect(agentDeclaredByActiveLayer(state, "aider")).toBe(false);
        expect(findAgentSpec(state, "aider")).toEqual(SPEC); // inherited, visible in the merge
        expect(agentMark(state, "aider")).toBe("global");

        // Same limit as `removeRole` and `caesar agents remove`: the merge by
        // key cannot express the deletion of an inherited entry.
        const attempted = removeAgentSpec(state, "aider");
        expect(findAgentSpec(attempted, "aider")).toEqual(SPEC);
        expect(isDirty(attempted)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("an inherited declaration, once modified, moves in full to the active layer", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-agent-override-"));
      try {
        await saveLayer("global", root, { agents: [SPEC] });
        const state = await loadConfigState(root);

        const updated = updateAgentSpec(state, "aider", { bin: "/opt/aider" });
        expect(agentDeclaredByActiveLayer(updated, "aider")).toBe(true);
        expect(agentMark(updated, "aider")).toBeNull(); // nothing left to override
        // The entry moves in full, arguments included: that is the merge by key.
        expect(findAgentSpec(updated, "aider")).toEqual({ ...SPEC, bin: "/opt/aider" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("survives the disk round-trip, capability included", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-agent-save-"));
      try {
        const state = upsertAgentSpec(await loadConfigState(root), { ...SPEC, capabilities: { nativeReadOnly: true } });
        await saveConfigState(root, state);

        const reloaded = await loadConfigState(root);
        expect(findAgentSpec(reloaded, "aider")).toEqual({ ...SPEC, capabilities: { nativeReadOnly: true } });
        expect(isDirty(reloaded)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("editing the policy", () => {
  it("updatePolicy merges the given fields without touching the others", () => {
    const state = emptyState();
    const updated = updatePolicy(state, { max_parallel: 8, allow_recursion: true });
    expect(effectiveConfig(updated).policy.max_parallel).toBe(8);
    expect(effectiveConfig(updated).policy.allow_recursion).toBe(true);
    expect(effectiveConfig(updated).policy.default_mode).toBe(effectiveConfig(state).policy.default_mode);
  });

  it("the default network is set like the other fields, and cycles through its three values", () => {
    // The counterpart of the Policy screen's gesture (Enter on "Default
    // network"), which the render harness cannot prove: it mounts the
    // screen with a no-op `onChange`.
    const state = emptyState();
    expect(effectiveConfig(state).policy.default_network).toBe("auto");
    const updated = updatePolicy(state, { default_network: cycle(NETWORK_OPTIONS, "auto") });
    expect(effectiveConfig(updated).policy.default_network).toBe("on");
    expect(cycle(NETWORK_OPTIONS, "off")).toBe("auto");
  });

  it("setPolicyListEntry: \"denied\" wins, but this module only adds/removes — the rule stays in @caesar/core", () => {
    const state = emptyState();
    const withAllowed = setPolicyListEntry(state, "allowed", "codex", true);
    expect(effectiveConfig(withAllowed).policy.allowed).toContain("codex");

    const withoutAllowed = setPolicyListEntry(withAllowed, "allowed", "codex", false);
    expect(effectiveConfig(withoutAllowed).policy.allowed).not.toContain("codex");

    const withDenied = setPolicyListEntry(state, "denied", "codex", true);
    expect(effectiveConfig(withDenied).policy.denied).toContain("codex");
  });

  it("materializes the effective list (inherited included), not only the added id — same rule as materializePolicyList", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-materialize-"));
      try {
        await saveLayer("global", root, { policy: { denied: ["copilot"] } });
        const state = await loadConfigState(root); // activeScope "project"

        const edited = setPolicyListEntry(state, "denied", "opencode", true);
        // The project layer now carries the whole effective list (inherited "copilot" + "opencode"),
        // never "opencode" alone — without which the inherited denial of "copilot" would vanish from disk.
        expect(edited.draft.policy?.denied).toEqual(["copilot", "opencode"]);
        expect(effectiveConfig(edited).policy.denied).toEqual(["copilot", "opencode"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("save/load round-trip", () => {
  it("saveConfigState then loadConfigState return exactly what was modified", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-roundtrip-"));
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
        // A fresh reload has no pending change anymore.
        expect(isDirty(reloaded)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("pickAgentForRoleName", () => {
  it("picks the first installed and allowed agent, in the role's order", () => {
    const state = upsertRole(emptyState(), ROLE);
    const installed = new Map([
      ["codex", false],
      ["antigravity", true],
      ["opencode", true],
    ]);
    const pick = pickAgentForRoleName(state, ROLE.name, installed);
    expect(pick && "agentId" in pick ? pick.agentId : undefined).toBe("antigravity");
  });

  it("falls back to the second choice if the first is denied by the policy (\"denied\")", () => {
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

  it("returns null for an unknown role", () => {
    expect(pickAgentForRoleName(emptyState(), "ghost-role", new Map())).toBeNull();
  });
});

describe("editing scope", () => {
  it("loadConfigState carries the \"project\" scope by default", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-scope-default-"));
      try {
        const state = await loadConfigState(root);
        expect(state.activeScope).toBe("project");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("nextScope cycles global → project → local → global", () => {
    expect(nextScope("global")).toBe("project");
    expect(nextScope("project")).toBe("local");
    expect(nextScope("local")).toBe("global");
  });

  it("setScope restarts from the new layer's last saved version, never from the old layer's draft", async () => {
    await withFakeHome(async () => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-scope-switch-"));
      try {
        await saveLayer("global", root, { policy: { max_parallel: 5 } });
        const state = await loadConfigState(root); // "project"
        const edited = updatePolicy(state, { max_parallel: 42 }); // pending change on "project"
        expect(isDirty(edited)).toBe(true);

        const onGlobal = setScope(edited, "global");
        expect(onGlobal.activeScope).toBe("global");
        // Restarts from disk for "global" (max_parallel=5), not from the "42" that belonged to the "project" draft.
        expect(onGlobal.draft.policy?.max_parallel).toBe(5);
        expect(isDirty(onGlobal)).toBe(false);

        // Coming back to "project" indeed finds its last *saved* version (empty here, never saved) —
        // the change to 42 was never saved, so it is indeed lost, as expected for the explicit scope
        // switch (confirmed by the caller, see `App.tsx`).
        const backToProject = setScope(onGlobal, "project");
        expect(backToProject.draft.policy?.max_parallel).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("inheritance marks", () => {
    it("policyFieldMark signals a layer less specific than the active layer, never the active layer itself", async () => {
      await withFakeHome(async () => {
        const root = await mkdtemp(join(tmpdir(), "caesar-tui-mark-policy-"));
        try {
          await saveLayer("global", root, { policy: { max_parallel: 9 } });
          const state = await loadConfigState(root); // "project": has not overridden max_parallel yet

          expect(policyFieldMark(state, "max_parallel")).toBe("global");
          expect(policyFieldMark(state, "allow_recursion")).toBe("default"); // never declared anywhere

          // On the global layer itself, nothing left to override for this field: no mark.
          const onGlobal = setScope(state, "global");
          expect(policyFieldMark(onGlobal, "max_parallel")).toBeNull();

          // Once "project" declares the field in turn, the mark disappears.
          const overridden = updatePolicy(state, { max_parallel: 3 });
          expect(policyFieldMark(overridden, "max_parallel")).toBeNull();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    });

    it("roleMark and roleDeclaredByActiveLayer reflect a role's provenance", async () => {
      await withFakeHome(async () => {
        const root = await mkdtemp(join(tmpdir(), "caesar-tui-mark-role-"));
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

  it("the scenario that matters: saving in global scope from a project only touches the global file", async () => {
    await withFakeHome(async (home) => {
      const root = await mkdtemp(join(tmpdir(), "caesar-tui-scope-global-save-"));
      try {
        const projectPath = configPathFor("project", root);
        const globalPath = configPathFor("global", root);
        expect(globalPath.startsWith(home)).toBe(true); // makes sure we target the neutralized HOME, not the real one

        let state = await loadConfigState(root); // "project" by default, like the TUI at startup
        state = setScope(state, "global"); // explicit scope switch (the "p" key)
        state = updatePolicy(state, { max_parallel: 7 }); // one change, pending on "global"
        expect(isDirty(state)).toBe(true);

        await saveConfigState(root, state); // "s": saves only the active layer

        // The global file changed...
        const globalContent = await readFile(globalPath, "utf8");
        expect(globalContent).toContain("max_parallel");
        expect(globalContent).toContain("7");

        // ...and the project file was never created (no write touched the project layer).
        await expect(readFile(projectPath, "utf8")).rejects.toThrow();

        const reloaded = await loadConfigState(root, "project");
        expect(effectiveConfig(reloaded).policy.max_parallel).toBe(7); // the project does inherit from global
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
