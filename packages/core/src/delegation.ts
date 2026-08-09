/**
 * Résout une demande de délégation — rôle et/ou agent explicite, mode,
 * isolation, timeout, contexte — en ce qu'il faut pour appeler `runTask`, ou
 * en un refus portant un motif prêt à afficher.
 *
 * Point d'assemblage partagé par `orch run` (`packages/cli/src/commands/run.ts`)
 * et `orch_delegate` (`packages/mcp-server/src/tools/delegate.ts`), qui
 * appliquaient jusqu'ici cette même règle en deux endroits, avec le même
 * risque qu'une seule des deux copies dérive au fil d'une future
 * modification — voir le rapport de correction de la tâche 7. Ordre de
 * résolution : rôle (s'il y en a un) → agent (l'entrée explicite l'emporte
 * sur le choix issu du rôle, mais pas sur ses valeurs par défaut de
 * mode/isolation/timeout/prompt système) → catalogue → politique.
 *
 * Ne dépend d'aucun contexte propre à une façade (pas d'`Io` du CLI, pas de
 * session MCP) : uniquement des types de `@orch/core`/`@orch/protocol`, pour
 * rester réutilisable telle quelle par le TUI (tâche à venir).
 *
 * Ce que cette fonction ne fait pas, délibérément : elle ne valide pas la
 * *forme* de `mode`/`isolation` (chaîne quelconque côté CLI, énumération
 * déjà typée par le schéma zod côté MCP) — cette validation est propre au
 * transport de chaque façade, qui la fait avant d'appeler `resolveDelegation`
 * avec des valeurs déjà typées. Elle ne lit pas non plus de fichier pour
 * `context` (le `@fichier` du CLI est résolu par son appelant) : elle ne fait
 * que fusionner le contexte déjà résolu avec le prompt système du rôle.
 */
import type { Isolation, TaskMode } from "@orch/protocol";
import type { OrchConfig } from "./config.js";
import { parseDuration } from "./config.js";
import { checkDelegation } from "./policy.js";
import { pickAgentForRole, resolveRole } from "./roles.js";
import { findAgentDefinition, findBinaryInPath } from "./registry/index.js";

export interface DelegationParams {
  role?: string;
  agent?: string;
  mode?: TaskMode;
  isolation?: Isolation | "auto";
  /** Contexte déjà résolu (un éventuel `@fichier` côté CLI est lu avant l'appel) ; fusionné ici avec le prompt système du rôle, s'il y en a un. */
  context?: string;
  /** Durée brute ("10m", "90s"…) ; le motif de `parseDuration` est rendu tel quel en cas d'échec. */
  timeout?: string;
  /** Profondeur de délégation, transmise à `checkDelegation`. 0 (défaut) pour un appel de premier niveau — CLI, serveur MCP. */
  depth?: number;
}

export interface ResolvedDelegation {
  agentId: string;
  /** Nom du rôle, si `params.role` en portait un — à transmettre tel quel à `RunTaskInput.role`. */
  role?: string;
  mode: TaskMode;
  isolation: Isolation | "auto";
  timeoutMs: number;
  context?: string;
}

export type DelegationResult = ResolvedDelegation | { error: string };

export async function resolveDelegation(config: OrchConfig, root: string, params: DelegationParams): Promise<DelegationResult> {
  if (!params.agent && !params.role) {
    return { error: "Un agent ou un rôle est requis." };
  }

  const role = params.role ? await resolveRole(config, root, params.role) : null;
  if (params.role && !role) {
    return { error: `Rôle inconnu : "${params.role}".` };
  }

  let agentId: string;
  if (params.agent) {
    agentId = params.agent;
  } else if (role) {
    const installed = new Map<string, boolean>();
    await Promise.all(
      role.agents.map(async (id) => {
        const def = findAgentDefinition(id);
        installed.set(id, def ? (await findBinaryInPath(def.bin)) !== null : false);
      }),
    );
    const pick = pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: config.policy });
    if ("error" in pick) return { error: pick.error };
    agentId = pick.agentId;
  } else {
    // Inatteignable : la garde en tête de fonction exige déjà l'un des deux.
    return { error: "Un agent ou un rôle est requis." };
  }

  if (!findAgentDefinition(agentId)) {
    return { error: `Agent inconnu : "${agentId}".` };
  }

  const decision = checkDelegation(config.policy, { agentId, depth: params.depth ?? 0 });
  if (!decision.allowed) {
    return { error: decision.reason };
  }

  const mode: TaskMode = params.mode ?? role?.mode ?? config.policy.default_mode;
  const isolation: Isolation | "auto" = params.isolation ?? role?.isolation ?? config.policy.default_isolation;

  let timeoutMs: number;
  try {
    timeoutMs = params.timeout ? parseDuration(params.timeout) : (role?.timeout_ms ?? config.policy.default_timeout_ms);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  let context = params.context;
  if (role?.systemPrompt) {
    context = [role.systemPrompt, context].filter((part) => part && part.trim() !== "").join("\n\n---\n\n");
  }

  const result: ResolvedDelegation = { agentId, mode, isolation, timeoutMs };
  if (params.role) result.role = params.role;
  if (context !== undefined) result.context = context;
  return result;
}
