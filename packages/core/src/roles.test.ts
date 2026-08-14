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
    purpose: "Reviews a diff.",
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

  it("returns null for an unknown role", async () => {
    const config = defaultConfig();
    expect(await resolveRole(config, root, "nonexistent")).toBeNull();
  });

  it("resolves a role and loads its system prompt", async () => {
    await mkdir(join(root, ".caesar", "roles"), { recursive: true });
    await writeFile(join(root, ".caesar", "roles", "reviewer.md"), "You are a strict reviewer.", "utf8");

    const config: CaesarConfig = {
      policy: defaultConfig().policy,
      roles: [role({ system_prompt_file: "roles/reviewer.md" })],
      agents: [],
    };

    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved).not.toBeNull();
    expect(resolved?.systemPrompt).toBe("You are a strict reviewer.");
    expect(resolved?.name).toBe("reviewer");
  });

  it("a role without a system_prompt_file has an empty system prompt", async () => {
    const config: CaesarConfig = { policy: defaultConfig().policy, roles: [role()], agents: [] };
    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved?.systemPrompt).toBe("");
  });

  it("system_prompt_file missing from disk: empty prompt, no error", async () => {
    const config: CaesarConfig = {
      policy: defaultConfig().policy,
      roles: [role({ system_prompt_file: "roles/absent.md" })],
      agents: [],
    };
    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved?.systemPrompt).toBe("");
  });

  it("system_prompt_file unreadable for a reason other than absence throws an error naming the role and the path", async () => {
    // A directory in place of the expected file: the read fails with something other than ENOENT.
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
  it("selects the first installed and allowed agent", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy() });
    expect(pick).toEqual({ agentId: "codex", skipped: [] });
  });

  it("falls back to the second agent when the first is not installed", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: (id) => id !== "codex", policy: policy() });
    expect(pick).toMatchObject({ agentId: "antigravity" });
    if ("skipped" in pick) {
      expect(pick.skipped).toHaveLength(1);
      expect(pick.skipped[0]?.agentId).toBe("codex");
      expect(pick.skipped[0]?.reason).toMatch(/not installed/);
    }
  });

  it("falls back to the second agent when the first is refused by the policy", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy({ denied: ["codex"] }) });
    expect(pick).toMatchObject({ agentId: "antigravity" });
    if ("skipped" in pick) {
      expect(pick.skipped).toHaveLength(1);
      expect(pick.skipped[0]?.agentId).toBe("codex");
      expect(pick.skipped[0]?.reason).toContain("codex");
    }
  });

  it("falls back when the first is refused on recursion grounds (claude agent)", () => {
    const r = role({ agents: ["claude", "codex"] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy({ allow_recursion: false }) });
    expect(pick).toMatchObject({ agentId: "codex" });
    if ("skipped" in pick) {
      expect(pick.skipped[0]?.reason).toContain("claude");
    }
  });

  it("error enumerating every reason when no agent fits", () => {
    const r = role({ agents: ["codex", "antigravity"] });
    const pick = pickAgentForRole(r, { isInstalled: (id) => id !== "codex", policy: policy({ denied: ["antigravity"] }) });
    expect("error" in pick).toBe(true);
    if ("error" in pick) {
      expect(pick.error).toContain("reviewer");
      expect(pick.error).toContain("codex");
      expect(pick.error).toMatch(/not installed/);
      expect(pick.error).toContain("antigravity");
    }
  });

  it("empty candidate agents list: dedicated error, without sweeping skipped", () => {
    const r = role({ agents: [] });
    const pick = pickAgentForRole(r, { isInstalled: () => true, policy: policy() });
    expect("error" in pick).toBe(true);
    if ("error" in pick) {
      expect(pick.error).toContain("reviewer");
      expect(pick.error).toMatch(/empty/);
    }
  });
});
