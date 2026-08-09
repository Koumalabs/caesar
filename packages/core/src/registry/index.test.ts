import { describe, expect, it } from "vitest";
import { createGenericAgent } from "./generic.js";
import {
  AGENT_DEFINITIONS,
  detectAgentInstallation,
  findAgentDefinition,
  findBinaryInPath,
  listAgentDefinitions,
  resolveAgentDefinition,
} from "./index.js";

describe("catalogue des agents", () => {
  it("expose les cinq agents connus", () => {
    const ids = listAgentDefinitions().map((agent) => agent.id);
    expect(ids).toEqual(["codex", "antigravity", "opencode", "copilot", "claude"]);
  });

  it("résout un agent par identifiant", () => {
    expect(resolveAgentDefinition("codex")).toBe(AGENT_DEFINITIONS[0]);
  });

  it("lève sur un identifiant inconnu", () => {
    expect(() => resolveAgentDefinition("agent-fantome")).toThrow(/agent-fantome/);
  });

  it("findAgentDefinition renvoie undefined sur un identifiant inconnu, sans lever", () => {
    expect(findAgentDefinition("agent-fantome")).toBeUndefined();
  });
});

describe("détection d'installation", () => {
  it("détecte l'absence d'un binaire du PATH", async () => {
    const agent = createGenericAgent({ id: "fantome", bin: "ce-binaire-n-existe-pas-xyz", args: [] });
    const status = await detectAgentInstallation(agent);
    expect(status).toEqual({ id: "fantome", bin: "ce-binaire-n-existe-pas-xyz", installed: false });
  });

  it("détecte un binaire présent du PATH et relève sa version quand elle est bon marché", async () => {
    // node est nécessairement présent : c'est le runtime qui exécute ce test.
    const agent = createGenericAgent({ id: "node-runtime", bin: "node", args: [] });
    const status = await detectAgentInstallation(agent);
    expect(status.installed).toBe(true);
    expect(status.path).toBeTruthy();
    expect(status.version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("findBinaryInPath renvoie null pour un binaire absent", async () => {
    expect(await findBinaryInPath("ce-binaire-n-existe-pas-xyz")).toBeNull();
  });

  it("findBinaryInPath renvoie un chemin pour un binaire présent", async () => {
    expect(await findBinaryInPath("node")).toBeTruthy();
  });
});
