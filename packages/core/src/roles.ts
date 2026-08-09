/**
 * Rôles : à quoi sert chaque sous-agent, et quel agent retenir pour un rôle
 * donné une fois le repli (agent préféré indisponible ou refusé) pris en
 * compte.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrchConfig, PolicyConfig, RoleConfig } from "./config.js";
import { isEnoent } from "./config.js";
import { isAgentAllowed, isRecursionAllowed } from "./policy.js";
import { findAgentDefinition, findBinaryInPath } from "./registry/index.js";
import type { GenericAgentSpec } from "./registry/generic.js";

export interface ResolvedRole extends RoleConfig {
  systemPrompt: string;
}

/**
 * Résout un rôle par nom et charge son prompt système. `null` si aucun rôle
 * de ce nom n'existe. `system_prompt_file` est résolu relativement à
 * `<root>/.orch/` ; un fichier absent n'est pas une erreur, `systemPrompt`
 * vaut simplement la chaîne vide — un rôle sans prompt système reste
 * parfaitement utilisable.
 */
export async function resolveRole(config: OrchConfig, root: string, name: string): Promise<ResolvedRole | null> {
  const role = config.roles.find((candidate) => candidate.name === name);
  if (!role) return null;

  let systemPrompt = "";
  if (role.system_prompt_file) {
    const path = join(root, ".orch", role.system_prompt_file);
    try {
      systemPrompt = await readFile(path, "utf8");
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error(
          `Impossible de lire le prompt système du rôle "${name}" (${path}) : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { ...role, systemPrompt };
}

/**
 * Résout, pour un ensemble d'identifiants d'agents, si chacun est installé
 * (binaire trouvé sur le `PATH`) — le prédicat synchrone attendu par
 * `pickAgentForRole`, précalculé une fois pour toutes. Partagé par
 * `resolveDelegation` (ci-dessous, un rôle à la fois) et par `orch role list`
 * (`packages/cli/src/commands/role.ts`, tous les rôles d'un coup) : les deux
 * façades resolvaient jusqu'ici cette même carte chacune de leur côté (tâche
 * 10, B).
 *
 * `extraAgents` (agents de configuration, `OrchConfig.agents`) permet à
 * `role.agents` de nommer un agent générique, pas seulement le catalogue
 * natif — voir C1 de la revue finale.
 */
export async function resolveInstalledMap(
  agentIds: Iterable<string>,
  extraAgents: readonly GenericAgentSpec[] = [],
): Promise<Map<string, boolean>> {
  const entries = await Promise.all(
    [...new Set(agentIds)].map(async (id): Promise<[string, boolean]> => {
      const def = findAgentDefinition(id, extraAgents);
      if (!def) return [id, false];
      return [id, (await findBinaryInPath(def.bin)) !== null];
    }),
  );
  return new Map(entries);
}

export interface AgentPick {
  agentId: string;
  skipped: Array<{ agentId: string; reason: string }>;
}

/**
 * Parcourt `role.agents` dans l'ordre et retient le premier agent à la fois
 * installé et autorisé par la politique. Chaque agent écarté est conservé
 * dans `skipped` avec un motif autonome (il nomme l'agent, pas seulement la
 * cause) : c'est ce qui rend le repli diagnosticable, l'intérêt même de
 * cette fonction.
 *
 * La profondeur de délégation n'entre pas en jeu ici — elle n'a de sens que
 * pour une tâche en cours (`checkDelegation`, appelé par le moteur avec une
 * profondeur réelle) et pas pour la simple sélection d'un agent candidat.
 * Les deux autres dimensions de la politique (listes allowed/denied,
 * récursion) s'appliquent en revanche pleinement.
 */
export function pickAgentForRole(
  role: RoleConfig,
  options: { isInstalled: (agentId: string) => boolean; policy: PolicyConfig },
): AgentPick | { error: string } {
  const skipped: Array<{ agentId: string; reason: string }> = [];

  for (const agentId of role.agents) {
    if (!options.isInstalled(agentId)) {
      skipped.push({ agentId, reason: `Agent "${agentId}" non installé : binaire introuvable dans le PATH.` });
      continue;
    }

    const allowedDecision = isAgentAllowed(options.policy, agentId);
    if (!allowedDecision.allowed) {
      skipped.push({ agentId, reason: allowedDecision.reason });
      continue;
    }

    const recursionDecision = isRecursionAllowed(options.policy, agentId);
    if (!recursionDecision.allowed) {
      skipped.push({ agentId, reason: recursionDecision.reason });
      continue;
    }

    return { agentId, skipped };
  }

  if (role.agents.length === 0) {
    return { error: `Aucun agent candidat pour le rôle "${role.name}" : la liste "agents" du rôle est vide.` };
  }
  return {
    error: `Aucun agent disponible pour le rôle "${role.name}" : ${skipped.map((entry) => entry.reason).join(" ; ")}`,
  };
}
