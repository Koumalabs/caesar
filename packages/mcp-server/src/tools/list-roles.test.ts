import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveLayer } from "@caesar/core";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarListRoles } from "./list-roles.js";

interface RoleRow {
  name: string;
  agents: string[];
  would_pick: string | null;
  reason?: string;
  skipped: Array<{ agentId: string; reason: string }>;
}

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

describe("caesar_list_roles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-list-roles-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reflects the configured roles and the agent that would be picked, no binary installed", async () => {
    await withFakeHome(() =>
      withEmptyPath(root, async () => {
        const session = await createSession(root);
        const result = await caesarListRoles(session);
        expect(result.isError).toBeFalsy();

        const roles = (result.structuredContent as { roles: RoleRow[] }).roles;
        const names = roles.map((r) => r.name).sort();
        expect(names).toEqual(["implementer", "investigator", "reviewer"]);

        // No binary installed on this reduced PATH: no agent can be picked.
        for (const role of roles) {
          expect(role.would_pick).toBeNull();
          expect(role.reason).toMatch(/not installed/);
        }
      }),
    );
  });

  it("the picked agent accounts for both installation and policy", async () => {
    await withFakeHome(() =>
      // "codex" is "installed" (an executable binary of that name exists on
      // the PATH) but refused by policy: the "reviewer" role (agents:
      // codex, antigravity) must fall back on "antigravity" — not installed
      // here but not refused, so it too is skipped, with a different reason.
      withFakeAgentAsBin("codex", async () => {
        const { config } = await loadConfig(root);
        await saveLayer("project", root, { ...config, policy: { ...config.policy, denied: ["codex"] } });

        const session = await createSession(root);
        const result = await caesarListRoles(session);
        const roles = (result.structuredContent as { roles: RoleRow[] }).roles;
        const reviewer = roles.find((r) => r.name === "reviewer");

        // No agent picked: `pickAgentForRole` (@caesar/core) then returns
        // only a single message concatenating each skip reason — no
        // structured `skipped` array in that case (see `roles.ts`).
        expect(reviewer?.would_pick).toBeNull();
        expect(reviewer?.reason).toMatch(/codex.*refused/);
        expect(reviewer?.reason).toMatch(/antigravity.*not installed/);
      }),
    );
  });
});
