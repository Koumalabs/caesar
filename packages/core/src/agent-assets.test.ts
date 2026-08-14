/**
 * On fabricated fixtures, never on the real catalog (still empty, see
 * `agent-assets.generated.ts`): this module needs nothing more than a test
 * `AgentAsset[]` to be exercised in full — that is the whole point of the
 * catalog as a parameter rather than imported.
 *
 * `withFakeHome` recreated locally (pattern from `packages/cli/test/support.ts`,
 * this test living in `core`): no test must touch the machine's real
 * `~/.claude/`, `~/.agents/`, `~/.config/opencode/`.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_TARGETS,
  installAgentAssets,
  planAgentAssets,
  renderClaudeCommand,
  renderOpencodeCommand,
  type AgentAsset,
} from "./agent-assets.js";
import { MCP_CLIENTS } from "./mcp-registration.js";

async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "caesar-assets-home-"));
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

const SKILL_ONLY_CATALOG: AgentAsset[] = [{ kind: "skill", id: "caesar", path: "SKILL.md", content: "# Caesar\nSkill content.\n" }];

const COMMAND_SOURCE = "---\ndescription: Lists the agents.\nallowed-tools: Bash(caesar:*)\nargument-hint: [filter]\n---\nCommand content.\n";

const FULL_CATALOG: AgentAsset[] = [
  { kind: "skill", id: "caesar", path: "SKILL.md", content: "# Caesar\nSkill content.\n" },
  { kind: "skill", id: "caesar", path: "references/cli.md", content: "# CLI\nReference.\n" },
  { kind: "command", id: "list-agents", path: "list-agents.md", content: COMMAND_SOURCE },
];

const SIX_TOOLS = [
  "mcp__caesar__caesar_list_agents",
  "mcp__caesar__caesar_list_roles",
  "mcp__caesar__caesar_status",
  "mcp__caesar__caesar_await",
  "mcp__caesar__caesar_logs",
  "mcp__caesar__caesar_diff",
];

describe("ASSET_TARGETS", () => {
  it("one row per MCP_CLIENTS client, without duplicate or omission", () => {
    const clients = ASSET_TARGETS.map((t) => t.client);
    expect(new Set(clients).size).toBe(clients.length);
    expect([...clients].sort()).toEqual([...MCP_CLIENTS].sort());
  });

  it("claude has a dedicated skillDir, distinct from the shared one; the four other targets share the same skillDir", () => {
    const claude = ASSET_TARGETS.find((t) => t.client === "claude")!;
    const others = ASSET_TARGETS.filter((t) => t.client !== "claude");
    expect(others.every((t) => t.skillDir === others[0]!.skillDir)).toBe(true);
    expect(claude.skillDir).not.toBe(others[0]!.skillDir);
  });

  it("only claude and opencode declare a commandsDir", () => {
    const withCommands = ASSET_TARGETS.filter((t) => t.commandsDir !== undefined).map((t) => t.client);
    expect(withCommands.sort()).toEqual(["claude", "opencode"]);
  });

  it("the literal paths match exactly the verified table of the brief", () => {
    expect(ASSET_TARGETS.find((t) => t.client === "claude")).toMatchObject({ skillDir: ".claude/skills/caesar", commandsDir: ".claude/commands" });
    expect(ASSET_TARGETS.find((t) => t.client === "codex")).toMatchObject({ skillDir: ".agents/skills/caesar" });
    expect(ASSET_TARGETS.find((t) => t.client === "copilot")).toMatchObject({ skillDir: ".agents/skills/caesar" });
    expect(ASSET_TARGETS.find((t) => t.client === "opencode")).toMatchObject({ skillDir: ".agents/skills/caesar", commandsDir: ".opencode/commands" });
    expect(ASSET_TARGETS.find((t) => t.client === "antigravity")).toMatchObject({ skillDir: ".agents/skills/caesar" });
  });
});

describe("planAgentAssets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-assets-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("the shared one is produced only once even when several targets designate it", () => {
    const plan = planAgentAssets({ root, scope: "project", clients: ["codex", "antigravity", "copilot"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.files.map((f) => f.path)).toEqual([join(root, ".agents/skills/caesar/SKILL.md")]);
  });

  it("claude receives its dedicated copy, never mixed with the shared one", () => {
    const plan = planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.files.map((f) => f.path)).toEqual([join(root, ".claude/skills/caesar/SKILL.md")]);
  });

  it("no destination escapes the targeted root", () => {
    const plan = planAgentAssets({ root, scope: "project", clients: [...MCP_CLIENTS], catalog: FULL_CATALOG });
    expect(plan.files.length).toBeGreaterThan(0);
    for (const file of plan.files) expect(file.path.startsWith(root + sep)).toBe(true);
  });

  it('invalid asset path ("..", absolute, empty segment): clear error, no write elsewhere', () => {
    const withPath = (path: string): AgentAsset[] => [{ kind: "skill", id: "caesar", path, content: "x" }];
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("../evil.md") })).toThrow(/\.\./);
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("/etc/passwd") })).toThrow(/absolute/);
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("a//b.md") })).toThrow(/empty/);
  });

  it("invalid asset path: backslash workaround rejected (pure backslash segment, and mixed with '/')", () => {
    // The AgentAsset.path contract promises POSIX separators only:
    // a backslash is never legitimate data. A naive split on
    // "/" alone would let this value through (no "/", hence a single
    // opaque segment, neither ".." nor empty) even though it does escape the
    // root once recombined by path.join on Windows — defect
    // flagged in review.
    const withPath = (path: string): AgentAsset[] => [{ kind: "skill", id: "caesar", path, content: "x" }];
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("..\\..\\..\\..\\evil.md") })).toThrow(/backslash/);
    // Mixed "/" and "\": the POSIX half of the path must not be enough to let it through.
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("references/..\\..\\evil.md") })).toThrow(
      /backslash/,
    );
    // Writes nothing under root/: the failure is thrown before any disk access.
    expect(readdirSync(root)).toEqual([]);
  });

  it("strictly pure: the tree remains intact after the call", () => {
    planAgentAssets({ root, scope: "project", clients: [...MCP_CLIENTS], catalog: FULL_CATALOG });
    expect(readdirSync(root)).toEqual([]);
  });

  it("CRLF content on disk vs LF in the catalog → unchanged", async () => {
    const dest = join(root, ".agents", "skills", "caesar", "SKILL.md");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, "# Caesar\r\nSkill content.\r\n", "utf8");

    const plan = planAgentAssets({ root, scope: "project", clients: ["codex"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]!.action).toBe("unchanged");
  });

  it("stale: names a caesar orphan without deleting it", async () => {
    const orphan = join(root, ".agents", "skills", "caesar", "references", "old.md");
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, "obsolete\n", "utf8");

    const plan = planAgentAssets({ root, scope: "project", clients: ["codex"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.stale).toContainEqual({ kind: "skill", id: "caesar", path: orphan });
    expect(existsSync(orphan)).toBe(true);
  });
});

describe("installAgentAssets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-assets-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates the per-target tree (dedicated, shared, commands)", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude", "opencode"], catalog: FULL_CATALOG });

    expect(await readFile(join(root, ".claude/skills/caesar/SKILL.md"), "utf8")).toContain("# Caesar");
    expect(await readFile(join(root, ".claude/skills/caesar/references/cli.md"), "utf8")).toContain("# CLI");
    expect(await readFile(join(root, ".agents/skills/caesar/SKILL.md"), "utf8")).toContain("# Caesar");
    expect(await readFile(join(root, ".claude/commands/caesar-list-agents.md"), "utf8")).toContain("allowed-tools");
    const opencodeCommand = await readFile(join(root, ".opencode/commands/caesar-list-agents.md"), "utf8");
    expect(opencodeCommand).toContain("description:");
    expect(opencodeCommand).not.toContain("allowed-tools");
  });

  it("idempotence: a second identical install does not touch mtimeMs, and returns \"unchanged\"", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const target = join(root, ".claude", "skills", "caesar", "SKILL.md");
    const before = (await stat(target)).mtimeMs;

    const second = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const after = (await stat(target)).mtimeMs;

    expect(after).toBe(before);
    expect(second.files.find((f) => f.path === target)?.action).toBe("unchanged");
  });

  it("divergent file actually replaced (update)", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const target = join(root, ".claude", "skills", "caesar", "SKILL.md");
    await writeFile(target, "modified by hand\n", "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });

    expect(result.files.find((f) => f.path === target)?.action).toBe("update");
    expect(await readFile(target, "utf8")).toBe("# Caesar\nSkill content.\n");
  });

  it("deleted file recreated", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const target = join(root, ".claude", "skills", "caesar", "SKILL.md");
    await rm(target);

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });

    expect(existsSync(target)).toBe(true);
    expect(result.files.find((f) => f.path === target)?.action).toBe("create");
  });

  it("global scope under a fake HOME: nothing is written under root/, everything goes under HOME", async () => {
    await withFakeHome(async (home) => {
      await installAgentAssets({ root, scope: "global", clients: ["claude"], catalog: FULL_CATALOG });

      expect(existsSync(join(root, ".claude"))).toBe(false);
      expect(existsSync(join(root, ".agents"))).toBe(false);
      expect(await readFile(join(home, ".claude", "skills", "caesar", "SKILL.md"), "utf8")).toContain("# Caesar");
    });
  });

  it("stale: caesar-* orphan named, never deleted", async () => {
    const commandsDir = join(root, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const orphan = join(commandsDir, "caesar-obsolete.md");
    await writeFile(orphan, "# obsolete\n", "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });

    expect(result.stale).toContainEqual({ kind: "command", id: "obsolete", path: orphan });
    expect(existsSync(orphan)).toBe(true);
  });
});

describe("renderClaudeCommand / renderOpencodeCommand", () => {
  const source: AgentAsset = { kind: "command", id: "list-agents", path: "list-agents.md", content: COMMAND_SOURCE };

  it("claude: the source, as-is", () => {
    expect(renderClaudeCommand(source)).toBe(COMMAND_SOURCE);
  });

  it("opencode: removes allowed-tools and argument-hint, keeps description and the body", () => {
    const rendered = renderOpencodeCommand(source);
    expect(rendered).toContain("description: Lists the agents.");
    expect(rendered).not.toContain("allowed-tools");
    expect(rendered).not.toContain("argument-hint");
    expect(rendered).toContain("Command content.");
  });
});

describe("merge of <root>/.claude/settings.json", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-assets-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("absent: created with the six tools", async () => {
    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    expect(result.settings?.action).toBe("create");
    const written = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
    expect(written.permissions.allow).toEqual(SIX_TOOLS);
  });

  it("append-if-absent, deduplication, everything else in the file preserved (unknown keys included)", async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ permissions: { allow: ["mcp__caesar__caesar_status", "Bash(ls:*)"], deny: ["Bash(rm:*)"] }, unknownTopLevel: { keep: true } }),
      "utf8",
    );

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    expect(result.settings?.action).toBe("update");
    expect([...result.settings!.added].sort()).toEqual(SIX_TOOLS.filter((t) => t !== "mcp__caesar__caesar_status").sort());

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.unknownTopLevel).toEqual({ keep: true });
    expect(written.permissions.deny).toEqual(["Bash(rm:*)"]);
    expect(written.permissions.allow).toContain("Bash(ls:*)");
    expect(written.permissions.allow.filter((t: string) => t === "mcp__caesar__caesar_status")).toHaveLength(1);
    for (const tool of SIX_TOOLS) expect(written.permissions.allow).toContain(tool);
  });

  it("second pass: strict idempotence, no write (mtimeMs)", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    const path = join(root, ".claude", "settings.json");
    const before = (await stat(path)).mtimeMs;

    const second = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    const after = (await stat(path)).mtimeMs;

    expect(after).toBe(before);
    expect(second.settings?.action).toBe("unchanged");
    expect(second.settings?.added).toEqual([]);
  });

  it("invalid JSON: warning returned to the caller, file intact", async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ this is not JSON", "utf8");
    const before = await readFile(path, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it('"permissions" present but non-object (string): warning, file intact, no silent merge', async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    const before = JSON.stringify({ permissions: "foo" });
    await writeFile(path, before, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path) && w.includes("permissions"))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it('"permissions": null (placed by hand by the user): warning, never silently overwritten', async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    const before = JSON.stringify({ permissions: null });
    await writeFile(path, before, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it('"permissions.allow" present but non-list: warning, file intact', async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    const before = JSON.stringify({ permissions: { allow: "everything" } });
    await writeFile(path, before, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path) && w.includes("allow"))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("global scope: ~/.claude/settings.json is never touched", async () => {
    await withFakeHome(async (home) => {
      const result = await installAgentAssets({ root, scope: "global", clients: ["claude"], catalog: [] });
      expect(result.settings).toBeUndefined();
      expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    });
  });

  it("project scope but claude absent from the targets: no merge", async () => {
    const result = await installAgentAssets({ root, scope: "project", clients: ["codex"], catalog: [] });
    expect(result.settings).toBeUndefined();
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
  });
});
