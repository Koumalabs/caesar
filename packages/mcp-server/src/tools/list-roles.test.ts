import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveProjectConfig } from "@orch/core";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchListRoles } from "./list-roles.js";

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

describe("orch_list_roles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-list-roles-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reflète les rôles configurés et l'agent qui serait retenu, aucun binaire installé", async () => {
    await withFakeHome(() =>
      withEmptyPath(root, async () => {
        const session = await createSession(root);
        const result = await orchListRoles(session);
        expect(result.isError).toBeFalsy();

        const roles = (result.structuredContent as { roles: RoleRow[] }).roles;
        const names = roles.map((r) => r.name).sort();
        expect(names).toEqual(["implementer", "investigator", "reviewer"]);

        // Aucun binaire installé sur ce PATH réduit : aucun agent ne peut être retenu.
        for (const role of roles) {
          expect(role.would_pick).toBeNull();
          expect(role.reason).toMatch(/non installé/);
        }
      }),
    );
  });

  it("l'agent retenu tient compte à la fois de l'installation et de la politique", async () => {
    await withFakeHome(() =>
      // "codex" est "installé" (un binaire exécutable de ce nom existe sur le
      // PATH) mais refusé par la politique : le rôle "reviewer" (agents :
      // codex, antigravity) doit retomber sur "antigravity" — non installé ici
      // mais pas refusé, donc lui aussi écarté, avec un motif différent.
      withFakeAgentAsBin("codex", async () => {
        const { config } = await loadConfig(root);
        await saveProjectConfig(root, { ...config, policy: { ...config.policy, denied: ["codex"] } });

        const session = await createSession(root);
        const result = await orchListRoles(session);
        const roles = (result.structuredContent as { roles: RoleRow[] }).roles;
        const reviewer = roles.find((r) => r.name === "reviewer");

        // Aucun agent retenu : `pickAgentForRole` (@orch/core) ne rend alors
        // qu'un message unique concaténant chaque motif d'écart — pas de
        // tableau `skipped` structuré dans ce cas (voir `roles.ts`).
        expect(reviewer?.would_pick).toBeNull();
        expect(reviewer?.reason).toMatch(/codex.*refusé/);
        expect(reviewer?.reason).toMatch(/antigravity.*non installé/);
      }),
    );
  });
});
