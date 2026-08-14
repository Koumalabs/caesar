import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import type { CaesarConfig, PolicyConfig, RoleConfig } from "./config.js";
import { pickAgentForRole, resolveRole } from "./roles.js";

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...defaultConfig().policy, ...overrides };
}

function role(overrides: Partial<RoleConfig> = {}): RoleConfig {
  return {
    name: "reviewer",
    purpose: "Relit un diff.",
    agents: ["codex", "antigravity"],
    mode: "read-only",
    isolation: "inplace",
    timeout_ms: 600_000,
    ...overrides,
  };
}

describe("resolveRole", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-roles-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("renvoie null pour un rôle inconnu", async () => {
    const config = defaultConfig();
    expect(await resolveRole(config, root, "inexistant")).toBeNull();
  });

  it("résout un rôle et charge son prompt système", async () => {
    await mkdir(join(root, ".caesar", "roles"), { recursive: true });
    await writeFile(join(root, ".caesar", "roles", "reviewer.md"), "Tu es un relecteur strict.", "utf8");

    const config: CaesarConfig = {
      policy: defaultConfig().policy,
      roles: [role({ system_prompt_file: "roles/reviewer.md" })],
      agents: [],
    };

    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved).not.toBeNull();
    expect(resolved?.systemPrompt).toBe("Tu es un relecteur strict.");
    expect(resolved?.name).toBe("reviewer");
  });

  it("un rôle sans system_prompt_file a un prompt système vide", async () => {
    const config: CaesarConfig = { policy: defaultConfig().policy, roles: [role()], agents: [] };
    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved?.systemPrompt).toBe("");
  });

  it("system_prompt_file absent du disque : prompt vide, pas d'erreur", async () => {
    const config: CaesarConfig = {
      policy: defaultConfig().policy,
      roles: [role({ system_prompt_file: "roles/absent.md" })],
      agents: [],
    };
    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved?.systemPrompt).toBe("");
  });

  it("system_prompt_file illisible pour une autre raison qu'une absence lève une erreur nommant le rôle et le chemin", async () => {
    // Un répertoire à la place du fichier attendu : la lecture échoue avec autre chose qu'ENOENT.
    const dirAsFile = join(root, ".caesar", "roles", "reviewer.md");
    await mkdir(dirAsFile, { recursive: true });

    const config: CaesarConfig = {
      policy: defaultConfig().policy,
      roles: [role({ system_prompt_file: "roles/reviewer.md" })],
      agents: [],
    };
    await expect(resolveRole(config, root, "reviewer")).rejects.toThrow(/reviewer/);
  });
});

describe("pickAgentForRole", () => {
  it("retient le premier agent installé et autorisé", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy() });
    expect(pick).toEqual({ agentId: "codex", skipped: [] });
  });

  it("replie sur le deuxième agent quand le premier n'est pas installé", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: (id) => id !== "codex", policy: policy() });
    expect(pick).toMatchObject({ agentId: "antigravity" });
    if ("skipped" in pick) {
      expect(pick.skipped).toHaveLength(1);
      expect(pick.skipped[0]?.agentId).toBe("codex");
      expect(pick.skipped[0]?.reason).toMatch(/non installé/);
    }
  });

  it("replie sur le deuxième agent quand le premier est refusé par la politique", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy({ denied: ["codex"] }) });
    expect(pick).toMatchObject({ agentId: "antigravity" });
    if ("skipped" in pick) {
      expect(pick.skipped).toHaveLength(1);
      expect(pick.skipped[0]?.agentId).toBe("codex");
      expect(pick.skipped[0]?.reason).toContain("codex");
    }
  });

  it("replie quand le premier est refusé pour cause de récursion (agent claude)", () => {
    const r = role({ agents: ["claude", "codex"] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy({ allow_recursion: false }) });
    expect(pick).toMatchObject({ agentId: "codex" });
    if ("skipped" in pick) {
      expect(pick.skipped[0]?.reason).toContain("claude");
    }
  });

  it("erreur énumérant tous les motifs quand aucun agent ne convient", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: (id) => id !== "codex", policy: policy({ denied: ["antigravity"] }) });
    expect("error" in pick).toBe(true);
    if ("error" in pick) {
      expect(pick.error).toContain("reviewer");
      expect(pick.error).toContain("codex");
      expect(pick.error).toMatch(/non installé/);
      expect(pick.error).toContain("antigravity");
    }
  });

  it("liste vide d'agents candidats : erreur dédiée, sans balayer skipped", () => {
    const r = role({ agents: [] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy() });
    expect("error" in pick).toBe(true);
    if ("error" in pick) {
      expect(pick.error).toContain("reviewer");
      expect(pick.error).toMatch(/vide/);
    }
  });
});
