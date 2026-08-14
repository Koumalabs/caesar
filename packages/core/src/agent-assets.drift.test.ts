/**
 * Drift test: re-walks the REAL sources on disk
 * (`.claude/skills/caesar/`, `.claude/commands/caesar-*.md`) and compares the
 * result to the imported catalog (`AGENT_ASSETS`,
 * `agent-assets.generated.ts`).
 *
 * INDEPENDENT oracle — imports nothing from `scripts/generate-agent-assets.mjs`
 * and does not read its code: the derivation below is rewritten from
 * scratch, solely from the contract (sorted recursive walk, command
 * reading, CRLF→LF normalization, id/path rules). Why this deliberate
 * duplication rather than an import or a copy of the generator: a test
 * reusing its logic would no longer check that the sources and the
 * catalog are in sync, only that the generator is consistent WITH
 * ITSELF — a bug in its sorting, its normalization or its id derivation
 * would end up identical on both sides of the equality and would never be
 * seen. By rebuilding the derivation independently, this test puts side by
 * side two readings made through different code paths; should they diverge
 * one day — regression in the generator, or markdown edited by hand without
 * rerunning `pnpm run assets:sync` — that is precisely the bug we want to see.
 *
 * No mkdtemp here: this is intentional (see the task's brief). This test
 * reads the real repository, in place — it is the only way to check that
 * what is committed in `agent-assets.generated.ts` matches what is
 * committed next to it, under `.claude/`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_ASSETS } from "./agent-assets.generated.js";
import type { AgentAsset } from "./agent-assets.js";

// Repository root resolved from the position of THIS file, never from
// process.cwd() (which depends on where `pnpm test` was invoked — package,
// monorepo root, or elsewhere).
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..");

const SKILL_DIR = join(REPO_ROOT, ".claude", "skills", "caesar");
const COMMANDS_DIR = join(REPO_ROOT, ".claude", "commands");
// The repository's three sub-agents live here — never in the shipped
// catalog. Used only by the dedicated guard below, never by the
// derivation itself.
const AGENTS_DIR = join(REPO_ROOT, ".claude", "agents");

function toLf(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/**
 * Recursive walk of `dir`, SORTED at each level: the order of
 * `readdirSync` is guaranteed by no file system, and the two
 * sides of the comparison (oracle, catalog) must produce a stable,
 * identical order for a set equality to have a simple meaning to
 * verify.
 */
function walkSorted(dir: string, relPrefix = ""): string[] {
  const entries = [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const results: string[] = [];
  for (const entry of entries) {
    // Relative POSIX path built by hand (hardcoded "/"): that is the
    // AgentAsset.path contract (see agent-assets.ts), independent of the
    // host file system's separator.
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) results.push(...walkSorted(join(dir, entry.name), rel));
    else if (entry.isFile()) results.push(rel);
  }
  return results;
}

/** The skill: a single fixed id "caesar" (the name of the source folder, which is also the name of the installation folder — see agent-assets.ts), one path per file found under SKILL_DIR. */
function deriveSkillAssets(): AgentAsset[] {
  if (!existsSync(SKILL_DIR)) {
    throw new Error(`Drift oracle: source directory not found "${SKILL_DIR}" — the repository seems incomplete or the root badly resolved.`);
  }
  return walkSorted(SKILL_DIR).map((rel) => ({
    kind: "skill",
    id: "caesar",
    path: rel,
    content: toLf(readFileSync(join(SKILL_DIR, rel), "utf8")),
  }));
}

const COMMAND_PREFIX = "caesar-";
const COMMAND_SUFFIX = ".md";

/** The commands: each `caesar-<name>.md` of COMMANDS_DIR becomes `{ id: <name>, path: "<name>.md" }` — never a file without this prefix (hence never anything under .claude/agents/, which does not have this prefix either). */
function deriveCommandAssets(): AgentAsset[] {
  if (!existsSync(COMMANDS_DIR)) {
    throw new Error(`Drift oracle: source directory not found "${COMMANDS_DIR}" — the repository seems incomplete or the root badly resolved.`);
  }
  const names = readdirSync(COMMANDS_DIR)
    .filter((name) => name.startsWith(COMMAND_PREFIX) && name.endsWith(COMMAND_SUFFIX) && name.length > COMMAND_PREFIX.length + COMMAND_SUFFIX.length)
    .sort();
  return names.map((name) => {
    const id = name.slice(COMMAND_PREFIX.length, -COMMAND_SUFFIX.length);
    return {
      kind: "command",
      id,
      path: `${id}${COMMAND_SUFFIX}`,
      content: toLf(readFileSync(join(COMMANDS_DIR, name), "utf8")),
    };
  });
}

// Computed once, at module load: if the source directories are absent,
// the functions above throw immediately — the whole test file fails
// loudly rather than continuing on a truncated oracle.
const oracle: AgentAsset[] = [...deriveSkillAssets(), ...deriveCommandAssets()];

function sortKey(asset: AgentAsset): string {
  return `${asset.kind}:${asset.id}:${asset.path}`;
}

function bySortKey(a: AgentAsset, b: AgentAsset): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

describe("agent-assets catalog — drift against the sources (independent oracle)", () => {
  it("non-empty catalog (never a pass on empty): neither the oracle, nor AGENT_ASSETS", () => {
    // An equality between two empty arrays would pass trivially — that is
    // exactly the pass-on-empty this test must forbid.
    expect(
      oracle.length,
      "The drift oracle found nothing under .claude/skills/caesar/ and .claude/commands/caesar-*.md: the repository seems incomplete, or the guard's paths have changed.",
    ).toBeGreaterThan(0);
    expect(
      AGENT_ASSETS.length,
      'AGENT_ASSETS (packages/core/src/agent-assets.generated.ts) is empty — rerun "pnpm run assets:sync" to regenerate the catalog from the sources.',
    ).toBeGreaterThan(0);
  });

  it("sources and catalog are in sync: same entries, same contents", () => {
    const sortedOracle = [...oracle].sort(bySortKey);
    const sortedActual = [...AGENT_ASSETS].sort(bySortKey);
    expect(
      sortedActual,
      'The catalog (agent-assets.generated.ts) has drifted from the sources on disk (.claude/skills/caesar/, .claude/commands/caesar-*.md). Rerun "pnpm run assets:sync" to regenerate it.',
    ).toEqual(sortedOracle);
  });

  it("dedicated guard: .claude/agents/ (the repository's sub-agents) never enters the catalog", () => {
    // A full assertion in its own right, not merely a consequence of the
    // equality above: the equality would pass just as well if the generator
    // AND the oracle both read .claude/agents/ by mistake (the same bug
    // on both sides). This guard instead compares the catalog to the
    // REAL content of .claude/agents/, a source neither the oracle nor the
    // generator is supposed to touch.
    expect(existsSync(AGENTS_DIR)).toBe(true);
    const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"));
    expect(
      agentFiles.length,
      "no .md file found under .claude/agents/ — this guard no longer checks anything, verify the path.",
    ).toBeGreaterThan(0);

    for (const name of agentFiles) {
      // Full file name without the extension, NOT the "without caesar-
      // prefix" rule of the commands: the "caesar-race.md" sub-agent (agents)
      // and the "race" command (commands, id="race") are two distinct
      // things, absolutely not to be confused in this guard.
      const bareName = name.slice(0, -".md".length);
      const content = readFileSync(join(AGENTS_DIR, name), "utf8");

      expect(oracle.some((asset) => asset.id === bareName)).toBe(false);
      expect(oracle.some((asset) => asset.content === content)).toBe(false);
      expect(AGENT_ASSETS.some((asset) => asset.id === bareName)).toBe(false);
      expect(AGENT_ASSETS.some((asset) => asset.content === content)).toBe(false);
    }
  });
});
