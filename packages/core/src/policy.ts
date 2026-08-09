/**
 * Décisions d'autorisation : quels agents la politique du projet laisse-t-elle
 * déléguer, et à quelle profondeur.
 *
 * Chaque refus porte une `reason` rédigée pour un humain, qui nomme l'agent
 * et la règle appliquée : ces messages remontent tels quels à l'agent
 * principal via MCP (tâche à venir), un refus sans motif y est inexploitable.
 */
import type { PolicyConfig } from "./config.js";

/**
 * Quelle règle a produit un refus — voir CONTRÔLEUR-1 de la revue finale :
 * `Decision` ne portait jusqu'ici qu'une phrase, ce qui a produit un remède
 * générique dans `orch doctor` (« Autorisez-le avec "orch agents enable X"
 * ou "orch policy allow X" »), faux pour deux des trois motifs de refus —
 * ni l'un ni l'autre ne touche `allow_recursion`, seul motif du refus de
 * `claude` par défaut. `denied`/`allowlist`/`depth`/`recursion` permettent à
 * un appelant (CLI, TUI, tools MCP) de choisir le bon remède sans
 * réinterpréter le texte de `reason`.
 */
export type PolicyRule = "denied" | "allowlist" | "depth" | "recursion";

export type Decision = { allowed: true } | { allowed: false; reason: string; rule: PolicyRule };

/**
 * Règle des listes `allowed`/`denied` :
 * 1. `denied` l'emporte toujours sur `allowed` — un agent présent dans les
 *    deux listes est refusé.
 * 2. Si `allowed` est vide, tout agent non refusé passe. Sinon, seuls les
 *    agents listés passent.
 */
export function isAgentAllowed(policy: PolicyConfig, agentId: string): Decision {
  if (policy.denied.includes(agentId)) {
    return {
      allowed: false,
      rule: "denied",
      reason: `Agent "${agentId}" refusé : présent dans la liste "denied" de la politique.`,
    };
  }
  if (policy.allowed.length > 0 && !policy.allowed.includes(agentId)) {
    return {
      allowed: false,
      rule: "allowlist",
      reason: `Agent "${agentId}" refusé : la politique restreint la délégation aux agents listés dans "allowed" (${policy.allowed.join(", ")}).`,
    };
  }
  return { allowed: true };
}

/** `depth >= max_depth` est refusé. */
export function isDepthAllowed(policy: PolicyConfig, depth: number): Decision {
  if (depth >= policy.max_depth) {
    return {
      allowed: false,
      rule: "depth",
      reason: `Profondeur de délégation ${depth} refusée : la politique limite à max_depth = ${policy.max_depth}.`,
    };
  }
  return { allowed: true };
}

/**
 * Si `allow_recursion` est faux, l'agent `claude` est refusé : déléguer à
 * Claude depuis Claude Code est la récursion que ce réglage protège. C'est
 * la seule règle de la politique qui vise un agent nommément — voir le
 * brief de la tâche 5.
 *
 * Exportée séparément (en plus de `checkDelegation`) car `pickAgentForRole`
 * (roles.ts) doit appliquer cette même règle sans disposer d'une profondeur
 * de tâche : elle réutilise cette fonction plutôt que de dupliquer la
 * logique.
 */
export function isRecursionAllowed(policy: PolicyConfig, agentId: string): Decision {
  if (!policy.allow_recursion && agentId === "claude") {
    return {
      allowed: false,
      rule: "recursion",
      reason: `Agent "claude" refusé : allow_recursion est désactivé (déléguer à Claude depuis Claude Code serait une récursion).`,
    };
  }
  return { allowed: true };
}

/**
 * Compose les quatre règles de la politique, dans l'ordre où le brief les
 * énonce : listes allowed/denied, puis profondeur, puis récursion. Le
 * premier refus rencontré est celui renvoyé.
 */
export function checkDelegation(policy: PolicyConfig, input: { agentId: string; depth: number }): Decision {
  const agentDecision = isAgentAllowed(policy, input.agentId);
  if (!agentDecision.allowed) return agentDecision;

  const depthDecision = isDepthAllowed(policy, input.depth);
  if (!depthDecision.allowed) return depthDecision;

  return isRecursionAllowed(policy, input.agentId);
}

/**
 * Statut d'un agent vis-à-vis de la politique, hors profondeur de délégation
 * (qui n'a de sens que pour une tâche en cours — voir `pickAgentForRole`,
 * `roles.ts`, qui applique la même paire `isAgentAllowed`/`isRecursionAllowed`
 * sans profondeur non plus).
 *
 * Déplacée depuis `packages/cli/src/commands/agents.ts` (tâche 8, rapport de
 * correction) : `packages/tui` en avait besoin pour son écran Agents, et la
 * dupliquer dans le TUI ou faire dépendre `packages/tui` de `packages/cli`
 * pour deux fonctions pures était pire que de la ramener ici, à côté des
 * règles qu'elle compose — même raisonnement que `resolveDelegation`
 * (`delegation.ts`) à la tâche précédente. `packages/cli`
 * (`commands/agents.ts`, `commands/doctor.ts`) l'importe désormais d'ici.
 */
export function describeAgentPolicy(policy: PolicyConfig, agentId: string): Decision {
  const allowedDecision = isAgentAllowed(policy, agentId);
  if (!allowedDecision.allowed) return allowedDecision;
  return isRecursionAllowed(policy, agentId);
}

/**
 * Le remède qui vaut effectivement pour `rule` — voir CONTRÔLEUR-1 de la
 * revue finale. Centralisé ici plutôt que réécrit par chaque façade
 * (`orch doctor`, l'écran Agents du TUI, un futur tool MCP de diagnostic) :
 * c'est la même logique de correspondance rule → remède partout.
 *
 * - `"denied"` : seul `orch agents enable` retire l'agent de `denied` —
 *   `orch policy allow` ne le ferait pas passer pour autant (`denied`
 *   l'emporte toujours) et aurait l'effet de bord décrit sous `"allowlist"`.
 * - `"allowlist"` : `orch policy allow` est le bon remède, mais avec
 *   l'avertissement de CONTRÔLEUR-2 — si `allowed` était vide, cette
 *   commande restreint désormais tous les autres agents non explicitement
 *   listés.
 * - `"recursion"` : aucune sous-commande CLI dédiée aujourd'hui ; seule
 *   l'édition de `allow_recursion` (TUI, onglet Politique, ou le TOML
 *   directement) lève ce refus.
 * - `"depth"` : ne se corrige pas par agent — c'est la profondeur de la
 *   délégation en cours qui dépasse `max_depth`, pas une propriété de
 *   l'agent lui-même ; sans objet pour un diagnostic statique par agent
 *   (`orch doctor`), qui n'atteint jamais ce cas (il n'appelle pas
 *   `isDepthAllowed`).
 */
export function remedyFor(agentId: string, rule: PolicyRule): string {
  switch (rule) {
    case "denied":
      return `Autorisez-le avec "orch agents enable ${agentId}".`;
    case "allowlist":
      return (
        `Ajoutez-le avec "orch policy allow ${agentId}" — attention, si la liste "allowed" est vide aujourd'hui, ` +
        `cette commande la fera passer de "tout agent non refusé" à "seulement ${agentId}", refusant du même geste ` +
        `tous les autres agents (voir "orch policy show").`
      );
    case "recursion":
      return `Activez "allow_recursion" (onglet Politique du TUI "orch config", ou éditez .orch/config.toml — aucune sous-commande dédiée aujourd'hui).`;
    case "depth":
      return `Sans objet par agent : c'est la profondeur de délégation en cours qui dépasse "max_depth", pas une propriété de l'agent.`;
  }
}
