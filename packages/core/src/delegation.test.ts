import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV } from "@caesar/protocol";
import { defaultConfig } from "./config.js";
import type { CaesarConfig, RoleConfig } from "./config.js";
import { nextDelegationDepth, resolveDelegation } from "./delegation.js";

function role(overrides: Partial<RoleConfig> = {}): RoleConfig {
  return {
    name: "reviewer",
    purpose: "Reviews a diff.",
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
    root = await mkdtemp(join(tmpdir(), "caesar-delegation-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("neither agent nor role: refusal", async () => {
    const result = await resolveDelegation(defaultConfig(), root, {});
    expect("error" in result).toBe(true);
  });

  it("--agent wins over the choice derived from the role", async () => {
    const config: CaesarConfig = { ...defaultConfig(), roles: [role()] };
    const result = await resolveDelegation(config, root, { role: "reviewer", agent: "copilot" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.agentId).toBe("copilot");
      // The role still resolves for its defaults despite the explicit agent.
      expect(result.mode).toBe("read-only");
      expect(result.isolation).toBe("inplace");
      expect(result.role).toBe("reviewer");
    }
  });

  it("unknown role: refusal naming the role", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { role: "nonexistent" });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/nonexistent/);
  });

  it("agent unknown to the catalog: refusal", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "ghost-agent" });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/nknown/);
  });

  it("agent refused by the policy: exact reason from checkDelegation", async () => {
    const config: CaesarConfig = { ...defaultConfig(), policy: { ...defaultConfig().policy, denied: ["codex"] } };
    const result = await resolveDelegation(config, root, { agent: "codex" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe('Agent "codex" refused: present in the policy\'s "denied" list.');
    }
  });

  it("explicit mode/isolation/timeout win over the role's", async () => {
    const config: CaesarConfig = { ...defaultConfig(), roles: [role({ mode: "read-only", isolation: "inplace", timeout_ms: 60_000 })] };
    const result = await resolveDelegation(config, root, { role: "reviewer", agent: "copilot", mode: "write", isolation: "worktree", timeout: "5m" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mode).toBe("write");
      expect(result.isolation).toBe("worktree");
      expect(result.timeoutMs).toBe(5 * 60_000);
    }
  });

  it("no mode/isolation given: falls back to the policy defaults when there is no role", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "codex" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mode).toBe(defaultConfig().policy.default_mode);
      expect(result.isolation).toBe(defaultConfig().policy.default_isolation);
      expect(result.timeoutMs).toBe(defaultConfig().policy.default_timeout_ms);
    }
  });

  it("invalid duration: reason from parseDuration, as-is", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "codex", timeout: "3 fortnights" });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/Invalid duration/);
  });

  it("merges the given context with the role's system prompt", async () => {
    await mkdir(join(root, ".caesar"), { recursive: true });
    await writeFile(join(root, ".caesar", "system.md"), "You are a strict reviewer.", "utf8");
    const config: CaesarConfig = { ...defaultConfig(), roles: [role({ system_prompt_file: "system.md" })] };

    const result = await resolveDelegation(config, root, { role: "reviewer", agent: "copilot", context: "Additional context." });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.context).toBe("You are a strict reviewer.\n\n---\n\nAdditional context.");
    }
  });

  it("no role, no context given: context absent from the result", async () => {
    const result = await resolveDelegation(defaultConfig(), root, { agent: "codex" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.context).toBeUndefined();
  });

  it("role without an explicitly chosen agent: resolution does go through pickAgentForRole (@caesar/core)", async () => {
    // PATH reduced to an empty directory: no catalog agent is "installed"
    // there, whatever the development machine — the fallback mechanism
    // itself (candidate order, reason wording) is already covered in
    // detail by `roles.test.ts`; this test only checks that
    // `resolveDelegation` does delegate to `pickAgentForRole` rather than
    // picking an agent through another path.
    const emptyPathDir = await mkdtemp(join(tmpdir(), "caesar-delegation-emptypath-"));
    const previousPath = process.env["PATH"];
    process.env["PATH"] = emptyPathDir;
    try {
      const config: CaesarConfig = { ...defaultConfig(), roles: [role({ agents: ["codex", "antigravity"] })] };
      const result = await resolveDelegation(config, root, { role: "reviewer" });
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("reviewer");
        expect(result.error).toMatch(/not installed/);
      }
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      await rm(emptyPathDir, { recursive: true, force: true });
    }
  });
});

describe("resolveDelegation — network", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-network-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses — without writing anything to disk — an \"on\" that codex cannot honor in read-only", async () => {
    // The case that motivated the effort. The refusal falls before any task
    // directory is created: that is what the position of `decideNetwork` in
    // `resolveDelegation`, right after `checkDelegation`, guarantees.
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "read-only",
      network: "on",
      depth: 0,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected a refusal");
    expect(result.error).toContain("codex");
    expect(result.error).toContain("--mode write");
    expect(await readdir(root)).toEqual([]);
  });

  it("grants the same \"on\" as soon as the mode switches to write", async () => {
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

  it("under \"auto\", a read-only codex task still departs — but with a warning", async () => {
    // Without this nuance between `auto` and `on`, the `reviewer` and
    // `investigator` roles shipped by default would both be out of service.
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "read-only",
      depth: 0,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(false);
    expect(result.networkWarning).toContain("Network unavailable");
  });

  it("inherits from the role, then from the policy", async () => {
    const config: CaesarConfig = { ...defaultConfig(), roles: [role({ agents: ["codex"], network: "on" })] };
    const fromRole = await resolveDelegation(config, root, { role: "reviewer", mode: "write", depth: 0 });
    if ("error" in fromRole) throw new Error(fromRole.error);
    expect(fromRole.network).toBe(true);

    const policyConfig: CaesarConfig = {
      ...defaultConfig(),
      policy: { ...defaultConfig().policy, default_network: "off" },
    };
    const result = await resolveDelegation(policyConfig, root, { agent: "codex", mode: "write", depth: 0 });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(false);
  });

  it("the explicit request wins over the role", async () => {
    const config: CaesarConfig = { ...defaultConfig(), roles: [role({ agents: ["codex"], network: "on" })] };
    const result = await resolveDelegation(config, root, {
      role: "reviewer",
      mode: "write",
      network: "off",
      depth: 0,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(false);
  });

  it("admits it cannot close the network of an agent it does not confine", async () => {
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "opencode",
      mode: "write",
      network: "off",
      depth: 0,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.network).toBe(true);
    expect(result.networkWarning).toContain("does not know how to close it");
  });
});

/**
 * The in-place write refusal, seen from the first of the two gates.
 *
 * `prepareIsolation` renders the same verdict — it is the net that every
 * direct call to `runTask` goes through — but after creating the task
 * directory. Here, a refusal leaves nothing behind it: that is what the
 * last test of this block checks, and it is this gate's reason for being.
 */
describe("resolveDelegation — in-place write", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-delegation-inplace-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function initGitRepo(dir: string): Promise<void> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: dir });
    await run("git", ["config", "user.email", "caesar-test@example.com"], { cwd: dir });
    await run("git", ["config", "user.name", "Caesar Test"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    await run("git", ["add", "a.txt"], { cwd: dir });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  }

  it('refuses "inplace" + write in a usable repository, naming the explicit provenance', async () => {
    await initGitRepo(root);
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "write",
      isolation: "inplace",
      depth: 0,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/explicitly requested/);
      expect(result.error).toMatch(/allow_inplace_write/);
    }
  });

  it("names the role when the isolation comes from it, rather than the request", async () => {
    // The real case: an `implementer` role misconfigured as `inplace`. A
    // reason saying "explicitly requested" would send one to fix the wrong place.
    await initGitRepo(root);
    const config: CaesarConfig = {
      ...defaultConfig(),
      roles: [role({ name: "implementer", mode: "write", isolation: "inplace" })],
    };
    const result = await resolveDelegation(config, root, { role: "implementer", agent: "codex", depth: 0 });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/role "implementer"/);
  });

  it("names the policy when the isolation comes from its default", async () => {
    await initGitRepo(root);
    const config: CaesarConfig = {
      ...defaultConfig(),
      policy: { ...defaultConfig().policy, default_isolation: "inplace" },
    };
    const result = await resolveDelegation(config, root, { agent: "codex", mode: "write", depth: 0 });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/default_isolation/);
  });

  it("accepts under opt-in, and returns the permission to pass to the engine", async () => {
    await initGitRepo(root);
    const config: CaesarConfig = {
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
      // Without this handoff, `prepareIsolation` would refuse what
      // `resolveDelegation` just granted — the closed-by-default default
      // only makes sense if the permission travels.
      expect(result.allowInplaceWrite).toBe(true);
    }
  });

  it("accepts outside a git repository: no worktree would be possible there", async () => {
    const result = await resolveDelegation(defaultConfig(), root, {
      agent: "codex",
      mode: "write",
      isolation: "inplace",
      depth: 0,
    });
    expect("error" in result).toBe(false);
  });

  it("refuses without writing anything to disk", async () => {
    // Same promise as the network refusal, which already precedes any
    // write: a refused delegation must not leave a task directory behind.
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
 * `nextDelegationDepth` — see C4 of the final review: `$CAESAR_DEPTH` was
 * indeed exported to subprocesses (`taskEnv`, `@caesar/protocol`) but
 * never read back by anyone, which made `max_depth` unenforceable as soon
 * as a delegating agent was itself running as a sub-agent. Tested
 * directly rather than via the test process's real environment (see
 * the integration tests of `run.test.ts`, `@caesar/cli`, which cover the
 * end-to-end wiring): here, only the computation function.
 */
describe("nextDelegationDepth", () => {
  it("no inherited variable: depth 1 (first level of delegation)", () => {
    expect(nextDelegationDepth({})).toBe(1);
  });

  it("inherited depth n: returns n + 1", () => {
    expect(nextDelegationDepth({ [ENV.depth]: "3" })).toBe(4);
  });

  it("non-numeric inherited value: falls back to 0 before adding 1, rather than NaN", () => {
    // A NaN propagated all the way to `isDepthAllowed` (`depth >= max_depth`)
    // would always be false: the anti-recursion safeguard would disarm
    // itself silently on the slightest malformed variable. Checked explicitly.
    expect(nextDelegationDepth({ [ENV.depth]: "not-a-number" })).toBe(1);
    expect(Number.isNaN(nextDelegationDepth({ [ENV.depth]: "not-a-number" }))).toBe(false);
  });
});
