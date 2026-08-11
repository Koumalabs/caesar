/**
 * Résout une demande de délégation — rôle et/ou agent explicite, mode,
 * isolation, réseau, timeout, contexte — en ce qu'il faut pour appeler
 * `runTask`, ou en un refus portant un motif prêt à afficher.
 *
 * Point d'assemblage partagé par `orch run` (`packages/cli/src/commands/run.ts`)
 * et `orch_delegate` (`packages/mcp-server/src/tools/delegate.ts`), qui
 * appliquaient jusqu'ici cette même règle en deux endroits, avec le même
 * risque qu'une seule des deux copies dérive au fil d'une future
 * modification — voir le rapport de correction de la tâche 7. Ordre de
 * résolution : rôle (s'il y en a un) → agent (l'entrée explicite l'emporte
 * sur le choix issu du rôle, mais pas sur ses valeurs par défaut de
 * mode/isolation/réseau/timeout/prompt système) → catalogue → politique →
 * réseau (qui vient en dernier parce qu'il dépend du mode et de l'agent
 * retenus).
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
import { ENV } from "@orch/protocol";
import type { Isolation, TaskMode } from "@orch/protocol";
import type { OrchConfig } from "./config.js";
import { parseDuration } from "./config.js";
import { checkDelegation } from "./policy.js";
import { decideNetwork } from "./network.js";
import type { NetworkRequest } from "./network.js";
import { pickAgentForRole, resolveInstalledMap, resolveRole } from "./roles.js";
import { findAgentDefinition } from "./registry/index.js";

export interface DelegationParams {
  role?: string;
  agent?: string;
  mode?: TaskMode;
  isolation?: Isolation | "auto";
  network?: NetworkRequest;
  /** Contexte déjà résolu (un éventuel `@fichier` côté CLI est lu avant l'appel) ; fusionné ici avec le prompt système du rôle, s'il y en a un. */
  context?: string;
  /** Durée brute ("10m", "90s"…) ; le motif de `parseDuration` est rendu tel quel en cas d'échec. */
  timeout?: string;
  /**
   * Profondeur de délégation, transmise à `checkDelegation`. Obligatoire —
   * voir C4 de la revue finale : un paramètre à valeur par défaut
   * (`params.depth ?? 0`) est ce qui a laissé `max_depth` inappliqué sans
   * qu'aucun test ni la compilation ne le remarque. 0 pour un appel de
   * premier niveau (CLI, serveur MCP, sans `$ORCH_DEPTH` hérité) ; voir
   * `nextDelegationDepth` pour le calcul attendu côté façade.
   */
  depth: number;
}

/**
 * Profondeur à assigner à la *prochaine* délégation, calculée depuis
 * `$ORCH_DEPTH` hérité du processus courant — voir C4 de la revue finale :
 * cette variable était bien exportée vers les sous-processus (`taskEnv`,
 * `@orch/protocol`) mais jamais relue par personne, ce qui rendait
 * `max_depth` inapplicable dès qu'un agent délégant tournait lui-même comme
 * sous-agent d'une délégation précédente. `Number(process.env[...])` invalide
 * ou absent retombe sur 0 plutôt que sur `NaN` — un `NaN >= max_depth` serait
 * toujours faux et désarmerait silencieusement le garde-fou.
 */
export function nextDelegationDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV.depth];
  const inherited = raw === undefined ? 0 : Number(raw);
  return (Number.isFinite(inherited) ? inherited : 0) + 1;
}

export interface ResolvedDelegation {
  agentId: string;
  /** Nom du rôle, si `params.role` en portait un — à transmettre tel quel à `RunTaskInput.role`. */
  role?: string;
  mode: TaskMode;
  isolation: Isolation | "auto";
  /**
   * Le réseau sera-t-il disponible ? Déjà confronté à ce que l'agent retenu
   * permet — la demande tri-état, elle, s'arrête ici.
   */
  network: boolean;
  /**
   * Ce qu'il faut dire quand la demande et le possible n'ont pas coïncidé
   * sans pour autant justifier un refus : réseau coupé faute de mieux, ou
   * fermeture demandée que nous ne savons pas obtenir. Versé au rapport par
   * le moteur, à côté de l'avertissement d'isolation dégradée.
   */
  networkWarning?: string;
  timeoutMs: number;
  context?: string;
}

export type DelegationResult = ResolvedDelegation | { error: string };

export async function resolveDelegation(config: OrchConfig, root: string, params: DelegationParams): Promise<DelegationResult> {
  // Motif générique, volontairement sans nom de flag ni de champ : cette
  // fonction ne sait pas depuis quelle façade elle est appelée. Le CLI
  // (`orch run`) vérifie cette même condition en amont, avant d'appeler
  // `resolveDelegation`, pour rendre son propre message nommant les flags
  // exacts (`--agent`/`--role`) — voir `run.ts` et le rapport de correction
  // de la tâche 7. Pour le serveur MCP, dont les paramètres se nomment
  // justement "agent"/"role", ce motif générique convient tel quel.
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
    const installed = await resolveInstalledMap(role.agents, config.agents);
    const pick = pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: config.policy });
    if ("error" in pick) return { error: pick.error };
    agentId = pick.agentId;
  } else {
    // Inatteignable : la garde en tête de fonction exige déjà l'un des deux.
    return { error: "Un agent ou un rôle est requis." };
  }

  const agentDef = findAgentDefinition(agentId, config.agents);
  if (!agentDef) {
    return { error: `Agent inconnu : "${agentId}".` };
  }

  const decision = checkDelegation(config.policy, { agentId, depth: params.depth });
  if (!decision.allowed) {
    return { error: decision.reason };
  }

  const mode: TaskMode = params.mode ?? role?.mode ?? config.policy.default_mode;
  const isolation: Isolation | "auto" = params.isolation ?? role?.isolation ?? config.policy.default_isolation;

  // Après le mode, dont la décision dépend : un agent qui ne sait ouvrir le
  // réseau qu'en écriture ne peut être jugé qu'une fois le mode connu. Et
  // avant que quoi que ce soit ne soit écrit sur le disque — un refus ne
  // laisse aucun répertoire de tâche derrière lui.
  const netDecision = decideNetwork({
    agentId,
    requested: params.network ?? role?.network ?? config.policy.default_network,
    mode,
    control: agentDef.capabilities.network,
  });
  if (netDecision.refused) {
    return { error: `${netDecision.reason} ${netDecision.remedy}` };
  }

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

  const result: ResolvedDelegation = { agentId, mode, isolation, network: netDecision.available, timeoutMs };
  if (netDecision.warning !== undefined) result.networkWarning = netDecision.warning;
  if (params.role) result.role = params.role;
  if (context !== undefined) result.context = context;
  return result;
}
