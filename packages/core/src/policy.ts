/**
 * Décisions d'autorisation : quels agents la politique du projet laisse-t-elle
 * déléguer, et à quelle profondeur.
 *
 * Chaque refus porte une `reason` rédigée pour un humain, qui nomme l'agent
 * et la règle appliquée : ces messages remontent tels quels à l'agent
 * principal via MCP (tâche à venir), un refus sans motif y est inexploitable.
 */
import type { PolicyConfig } from "./config.js";

export type Decision = { allowed: true } | { allowed: false; reason: string };

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
      reason: `Agent "${agentId}" refusé : présent dans la liste "denied" de la politique.`,
    };
  }
  if (policy.allowed.length > 0 && !policy.allowed.includes(agentId)) {
    return {
      allowed: false,
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
