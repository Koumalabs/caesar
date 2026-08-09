import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveProjectConfig } from "@orch/core";
import { withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchListAgents } from "./list-agents.js";

interface AgentRow {
  id: string;
  installed: boolean;
  policy: { allowed: boolean; reason?: string };
}

/**
 * Un `PATH` réduit au strict répertoire donné : contrairement à
 * `withShimmedPath` (partagé avec les tests qui exécutent réellement un
 * script factice), aucun processus n'est lancé ici — `orchListAgents` ne
 * fait que sonder la présence de binaires (`access`). Inclure le répertoire
 * de `node` lui-même, comme le fait `withShimmedPath`, exposerait sur cette
 * machine de développement de vrais binaires d'agents installés à côté de
 * `node` (via nvm) et fausserait le test.
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

describe("orch_list_agents", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-list-agents-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reflète le catalogue, la présence des binaires, et l'autorisation de la politique chargée", async () => {
    await withFakeHome(() =>
      withEmptyPath(root, async () => {
        // Aucun binaire d'agent "installé" sur ce PATH entièrement maîtrisé.
        const { config } = await loadConfig(root);
        await saveProjectConfig(root, { ...config, policy: { ...config.policy, denied: ["codex"] } });

        const session = await createSession(root);
        const result = await orchListAgents(session);
        expect(result.isError).toBeFalsy();

        const agents = (result.structuredContent as { agents: AgentRow[] }).agents;
        expect(agents.map((a) => a.id).sort()).toEqual(["antigravity", "claude", "codex", "copilot", "opencode"]);
        expect(agents.every((a) => a.installed === false)).toBe(true);

        const codex = agents.find((a) => a.id === "codex");
        expect(codex?.policy.allowed).toBe(false);
        expect(codex?.policy.reason).toBe('Agent "codex" refusé : présent dans la liste "denied" de la politique.');

        const antigravity = agents.find((a) => a.id === "antigravity");
        expect(antigravity?.policy.allowed).toBe(true);
      }),
    );
  });
});
