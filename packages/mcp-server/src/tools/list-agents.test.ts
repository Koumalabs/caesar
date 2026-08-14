import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveLayer } from "@caesar/core";
import { withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarListAgents } from "./list-agents.js";

interface AgentRow {
  id: string;
  installed: boolean;
  policy: { allowed: boolean; reason?: string };
}

/**
 * A `PATH` reduced to strictly the given directory: unlike
 * `withShimmedPath` (shared with tests that actually execute a fake
 * script), no process is launched here — `caesarListAgents` only probes for
 * the presence of binaries (`access`). Including `node`'s own directory,
 * as `withShimmedPath` does, would expose on this development machine real
 * agent binaries installed next to `node` (via nvm) and skew the test.
 */
async function withEmptyPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env["PATH"];
  process.env["PATH"] = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}

describe("caesar_list_agents", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-list-agents-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reflects the catalog, binary presence, and the loaded policy's authorization", async () => {
    await withFakeHome(() =>
      withEmptyPath(root, async () => {
        // No agent binary "installed" on this fully controlled PATH.
        const { config } = await loadConfig(root);
        await saveLayer("project", root, { ...config, policy: { ...config.policy, denied: ["codex"] } });

        const session = await createSession(root);
        const result = await caesarListAgents(session);
        expect(result.isError).toBeFalsy();

        const agents = (result.structuredContent as { agents: AgentRow[] }).agents;
        expect(agents.map((a) => a.id).sort()).toEqual(["antigravity", "claude", "codex", "copilot", "opencode"]);
        expect(agents.every((a) => a.installed === false)).toBe(true);

        const codex = agents.find((a) => a.id === "codex");
        expect(codex?.policy.allowed).toBe(false);
        expect(codex?.policy.reason).toBe('Agent "codex" refused: present in the policy\'s "denied" list.');

        const antigravity = agents.find((a) => a.id === "antigravity");
        expect(antigravity?.policy.allowed).toBe(true);
      }),
    );
  });
});
