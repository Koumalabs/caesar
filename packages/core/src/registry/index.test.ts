import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGenericAgent } from "./generic.js";
import {
  AGENT_DEFINITIONS,
  describeAgentCapabilities,
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

  it("findBinaryInPath accepte un chemin explicite sans le chercher dans le PATH", async () => {
    // La règle d'`execvp` : un nom contenant un séparateur désigne un fichier.
    // Sans elle, un agent déclaré par chemin absolu (`orch agents add --bin
    // /opt/mon-cli`) tournait mais était rapporté "absent" partout.
    const nodePath = process.execPath;
    expect(await findBinaryInPath(nodePath)).toBe(nodePath);
    expect(await findBinaryInPath("/opt/ce-chemin-n-existe-pas-xyz/bin")).toBeNull();
  });

  it("findBinaryInPath refuse un chemin explicite non exécutable", async () => {
    // Un fichier existant mais sans bit d'exécution n'est pas un binaire
    // lançable : le distinguer évite un "installé" trompeur.
    expect(await findBinaryInPath(fileURLToPath(import.meta.url))).toBeNull();
  });
});

/**
 * Déplacée depuis `packages/cli/src/commands/agents.ts` (tâche 8, rapport de
 * correction) — voir sa docstring pour le raisonnement. `packages/cli`
 * (`agents.ts`, `doctor.ts`) l'appelle désormais d'ici ; ses tests
 * continuent de passer sans modification.
 */
describe("describeAgentCapabilities", () => {
  it("aucune capacité notable : liste vide", () => {
    const agent = createGenericAgent({ id: "minimal", bin: "minimal-cli", args: [] });
    expect(describeAgentCapabilities(agent)).toEqual([]);
  });

  it("chaque capacité notable produit son propre libellé", () => {
    const agent = createGenericAgent({
      id: "complet",
      bin: "complet-cli",
      args: [],
      capabilities: {
        nativeReadOnly: true,
        outputSchema: true,
        finalMessageFile: true,
        resume: true,
        addDir: true,
        model: true,
        mcpInjection: "flag",
      },
    });
    expect(describeAgentCapabilities(agent)).toEqual([
      "lecture-seule native",
      "schéma de sortie",
      "message final fichier",
      "reprise",
      "répertoires additionnels",
      "choix du modèle",
      "mcp:flag",
    ]);
  });

  it("chaque agent du catalogue natif a au moins une capacité notable", () => {
    for (const def of listAgentDefinitions()) {
      expect(describeAgentCapabilities(def).length).toBeGreaterThan(0);
    }
  });
});
