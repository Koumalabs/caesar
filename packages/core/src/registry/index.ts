import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDefinition } from "./types.js";
import { antigravityAgent } from "../adapters/antigravity.js";
import { claudeAgent } from "../adapters/claude.js";
import { codexAgent } from "../adapters/codex.js";
import { copilotAgent } from "../adapters/copilot.js";
import { opencodeAgent } from "../adapters/opencode.js";

const execFileAsync = promisify(execFile);

/** Le catalogue des agents connus nativement, dans un ordre stable. */
export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  codexAgent,
  antigravityAgent,
  opencodeAgent,
  copilotAgent,
  claudeAgent,
];

export function listAgentDefinitions(): readonly AgentDefinition[] {
  return AGENT_DEFINITIONS;
}

export function findAgentDefinition(id: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((agent) => agent.id === id);
}

/** Résout un agent par identifiant. Lève si l'identifiant est inconnu. */
export function resolveAgentDefinition(id: string): AgentDefinition {
  const found = findAgentDefinition(id);
  if (!found) {
    const known = AGENT_DEFINITIONS.map((agent) => agent.id).join(", ");
    throw new Error(`Agent inconnu : "${id}" (connus : ${known})`);
  }
  return found;
}

/** Cherche un binaire exécutable dans le PATH, sans lancer de processus. */
export async function findBinaryInPath(bin: string): Promise<string | null> {
  const pathVar = process.env["PATH"] ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Absent de ce répertoire du PATH : on continue.
    }
  }
  return null;
}

export interface AgentInstallStatus {
  id: string;
  bin: string;
  installed: boolean;
  path?: string;
  version?: string;
}

async function probeVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 3000 });
    const version = stdout.trim().split("\n")[0]?.trim();
    return version || undefined;
  } catch {
    // Pas de --version, binaire qui répond mal, ou dépassement du délai :
    // l'installation reste avérée par la présence dans le PATH, la version
    // est simplement absente.
    return undefined;
  }
}

/**
 * Détecte si le binaire d'un agent est installé, et relève sa version quand
 * l'appel est bon marché (`--version`, borné dans le temps). Ne fait pas
 * partie de cette détection : le lancement d'une vraie tâche, ni aucune
 * sous-commande CLI (`orch doctor` viendra avec le package `cli`).
 */
export async function detectAgentInstallation(def: AgentDefinition): Promise<AgentInstallStatus> {
  const path = await findBinaryInPath(def.bin);
  if (!path) {
    return { id: def.id, bin: def.bin, installed: false };
  }
  const version = await probeVersion(def.bin);
  return version === undefined
    ? { id: def.id, bin: def.bin, installed: true, path }
    : { id: def.id, bin: def.bin, installed: true, path, version };
}

export { createGenericAgent, type GenericAgentSpec } from "./generic.js";
export * from "./types.js";
