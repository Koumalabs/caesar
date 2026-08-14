/**
 * Invariants of the shipped catalog (`AGENT_ASSETS`, `agent-assets.generated.ts`)
 * — independent of any source: this file rereads nothing from disk, it
 * only exercises what is already committed. It is the net that protects
 * the SILENT loading of the catalog by five different runtimes: a
 * malformed frontmatter, an id with the wrong prefix, or a leak of an
 * MCP tool specific to a single runtime crashes none of them — they
 * simply ignore the skill or the command, without saying so. These tests
 * make visible what the runtimes themselves keep quiet.
 *
 * Complementary to `agent-assets.drift.test.ts`: the drift test checks that
 * the catalog matches the sources, this one checks that the catalog
 * honors its own shape contract, whatever its origin.
 */
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ASSETS } from "./agent-assets.generated.js";
import { ASSET_TARGETS, type AgentAsset } from "./agent-assets.js";

/** Reads a scalar field of the YAML frontmatter (a "key: value" line). Enough here: the Claude Code frontmatter of this catalog (see `renderOpencodeCommand` in agent-assets.ts) has only single-line scalars. */
function frontmatterField(content: string, field: string): string | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return undefined;
  const block = match[1] ?? "";
  for (const line of block.split("\n")) {
    const found = new RegExp(`^${field}:\\s*(.*)$`).exec(line);
    if (found) return found[1];
  }
  return undefined;
}

describe("catalog invariants — non-empty", () => {
  it("AGENT_ASSETS is never empty", () => {
    expect(
      AGENT_ASSETS.length,
      'AGENT_ASSETS (packages/core/src/agent-assets.generated.ts) is empty — rerun "pnpm run assets:sync".',
    ).toBeGreaterThan(0);
  });

  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))("%s: non-empty content", (_label, asset) => {
    expect(asset.content.length).toBeGreaterThan(0);
  });
});

describe("catalog invariants — SKILL.md", () => {
  const skill = AGENT_ASSETS.find((asset) => asset.kind === "skill" && asset.path === "SKILL.md");
  // Name of the skill's installation folder for claude — it is THIS name
  // that the `name:` frontmatter must reproduce for the runtime to load it
  // (see the fact table at the top of agent-assets.ts).
  const installedSkillName = basename(ASSET_TARGETS.find((target) => target.client === "claude")!.skillDir);

  it('the "SKILL.md" entry exists', () => {
    expect(skill, 'no { kind: "skill", path: "SKILL.md" } entry in AGENT_ASSETS').toBeDefined();
  });

  it('opens with "---\\n" (frontmatter required)', () => {
    expect(skill!.content.startsWith("---\n")).toBe(true);
  });

  it(`frontmatter name === "${installedSkillName}" (the name of the installation folder)`, () => {
    expect(frontmatterField(skill!.content, "name")).toBe(installedSkillName);
  });

  it('frontmatter description non-empty, ≤ 1024 characters, starts with "Use when"', () => {
    const description = frontmatterField(skill!.content, "description");
    expect(description, "SKILL.md: no description field in the frontmatter").toBeDefined();
    expect(description!.length).toBeGreaterThan(0);
    expect(description!.length).toBeLessThanOrEqual(1024);
    expect(description!.startsWith("Use when")).toBe(true);
  });
});

describe("catalog invariants — references (SKILL.md excepted)", () => {
  const references = AGENT_ASSETS.filter((asset) => asset.kind === "skill" && asset.path !== "SKILL.md");

  it("at least one reference under references/", () => {
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((asset) => asset.path.startsWith("references/"))).toBe(true);
  });

  // Exempted, unlike SKILL.md: no frontmatter requirement on the
  // reference files (see the brief) — no assertion here beyond
  // their existence, deliberately.
});

describe("catalog invariants — commands", () => {
  const commands = AGENT_ASSETS.filter((asset) => asset.kind === "command");

  it("at least one command in the catalog", () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  it.each(commands.map((command) => [command.id, command] as const))(
    '"%s": path === id + ".md", non-empty id without the "caesar-" prefix, opens with "---\\n"',
    (_id, command: AgentAsset) => {
      expect(command.path).toBe(`${command.id}.md`);
      expect(command.id.length).toBeGreaterThan(0);
      // Without this safeguard, installation would compose `caesar-${id}.md`
      // from an id that already carries the prefix, producing
      // "caesar-caesar-*.md" (see agent-assets.ts, COMMAND_PREFIX).
      expect(command.id.startsWith("caesar-")).toBe(false);
      expect(command.content.startsWith("---\n")).toBe(true);
    },
  );
});

describe("catalog invariants — path safety", () => {
  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))(
    '%s: no "..", no absolute path, no backslash, no empty segment',
    (_label, asset: AgentAsset) => {
      expect(asset.path.includes("..")).toBe(false);
      expect(asset.path.startsWith("/")).toBe(false);
      expect(asset.path.includes("\\")).toBe(false);
      expect(asset.path.split("/").every((segment) => segment.length > 0)).toBe(true);
    },
  );
});

describe("catalog invariants — multi-runtime content", () => {
  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))(
    '%s: no occurrence of "mcp__caesar__" (prefix specific to a single runtime, the catalog is multi-runtime)',
    (_label, asset: AgentAsset) => {
      expect(asset.content.includes("mcp__caesar__")).toBe(false);
    },
  );

  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))(
    "%s: no \\r (everything in LF)",
    (_label, asset: AgentAsset) => {
      expect(asset.content.includes("\r")).toBe(false);
    },
  );
});
