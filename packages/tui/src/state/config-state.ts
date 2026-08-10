/**
 * Chargement, modifications en attente et enregistrement de la configuration
 * — le cœur du TUI, volontairement sans aucun rendu : chaque écran ne fait
 * qu'appeler ces fonctions et afficher le résultat.
 *
 * `@orch/core` reste la seule source de vérité (`loadConfig`, `saveLayer`) :
 * ce module ne relit ni ne réécrit le TOML lui-même, il tient juste la copie
 * de travail (`draft`) que l'utilisateur modifie avant d'enregistrer
 * explicitement — voir le brief de la tâche 8, "aucune modification ne
 * s'écrit sans action explicite".
 *
 * `saveConfigState` écrit tout `draft` (fusion comprise) dans la couche
 * projet — comportement conservé tel quel de `saveProjectConfig`, supprimée
 * par la tâche 13 au profit de `saveLayer`. C'est un correctif minimal pour
 * rester compilable après cette suppression, pas une adoption de la
 * superposition en écriture : le TUI n'a ni sélecteur de portée ni notion de
 * "ce que cette couche déclare en propre" pour l'instant — voir la tâche 15
 * ("Portée d'édition dans le TUI"), qui doit reprendre ce module pour cesser
 * d'aplatir la fusion dans le projet, exactement le défaut I11 que la tâche
 * 13 corrige côté CLI.
 *
 * Toutes les mutations sont pures : elles reçoivent un `ConfigState` et en
 * renvoient un nouveau, sans jamais toucher au disque ni à `state.saved`.
 * Seul `saveConfigState` écrit, et seul `loadConfigState` lit.
 */
import type { OrchConfig, PolicyConfig, RoleConfig } from "@orch/core";
import { loadConfig, pickAgentForRole, saveLayer } from "@orch/core";
import type { AgentPick } from "@orch/core";

export interface ConfigState {
  /** Dernière version connue du disque : après `loadConfigState`, ou après un `saveConfigState` réussi. */
  saved: OrchConfig;
  /** Copie de travail : tous les écrans lisent et modifient celle-ci. */
  draft: OrchConfig;
  sources: { global?: string; project?: string };
}

/** Comparaison structurelle par valeur — même motif que `packages/cli/src/commands/policy.ts` (`sameValue`). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Vrai s'il existe des modifications non enregistrées — l'indicateur permanent que le brief demande. */
export function isDirty(state: ConfigState): boolean {
  return !sameValue(state.saved, state.draft);
}

export async function loadConfigState(root: string): Promise<ConfigState> {
  const { config, sources } = await loadConfig(root);
  return { saved: config, draft: config, sources };
}

/** Enregistre `draft` sur disque puis fait de ce `draft` le nouveau `saved` — `isDirty` redevient faux. */
export async function saveConfigState(root: string, state: ConfigState): Promise<ConfigState> {
  // `state.draft` (un `OrchConfig` complet) satisfait structurellement `ConfigOverride` (tous ses champs sont
  // renseignés) : voir la note de tête de fichier, ce correctif minimal ne change pas ce qui est écrit.
  await saveLayer("project", root, state.draft);
  return { ...state, saved: state.draft };
}

function withDraft(state: ConfigState, draft: OrchConfig): ConfigState {
  return { ...state, draft };
}

// ---------------------------------------------------------------------------
// Agents : autorisation (liste "denied" de la politique)
// ---------------------------------------------------------------------------

/** Bascule l'autorisation d'un agent — présent dans "denied" ⇔ refusé, exactement la règle d'`isAgentAllowed` (`@orch/core`). */
export function toggleAgentDenied(state: ConfigState, agentId: string): ConfigState {
  const denied = new Set(state.draft.policy.denied);
  if (denied.has(agentId)) denied.delete(agentId);
  else denied.add(agentId);
  return withDraft(state, { ...state.draft, policy: { ...state.draft.policy, denied: [...denied] } });
}

// ---------------------------------------------------------------------------
// Politique
// ---------------------------------------------------------------------------

export function updatePolicy(state: ConfigState, patch: Partial<PolicyConfig>): ConfigState {
  return withDraft(state, { ...state.draft, policy: { ...state.draft.policy, ...patch } });
}

export type PolicyListField = "allowed" | "denied";

/** Ajoute ou retire `agentId` de `allowed`/`denied` — les deux écrans (Agents, Politique) partagent cette même opération. */
export function setPolicyListEntry(state: ConfigState, field: PolicyListField, agentId: string, present: boolean): ConfigState {
  const set = new Set(state.draft.policy[field]);
  if (present) set.add(agentId);
  else set.delete(agentId);
  return updatePolicy(state, { [field]: [...set] } as Partial<PolicyConfig>);
}

// ---------------------------------------------------------------------------
// Rôles
// ---------------------------------------------------------------------------

export function findRole(state: ConfigState, name: string): RoleConfig | undefined {
  return state.draft.roles.find((role) => role.name === name);
}

/** Crée un rôle (si `role.name` est nouveau) ou le remplace entièrement (s'il existe déjà) — même sémantique que `orch role add`. */
export function upsertRole(state: ConfigState, role: RoleConfig): ConfigState {
  const exists = state.draft.roles.some((r) => r.name === role.name);
  const roles = exists ? state.draft.roles.map((r) => (r.name === role.name ? role : r)) : [...state.draft.roles, role];
  return withDraft(state, { ...state.draft, roles });
}

export function removeRole(state: ConfigState, name: string): ConfigState {
  return withDraft(state, { ...state.draft, roles: state.draft.roles.filter((role) => role.name !== name) });
}

export function updateRole(state: ConfigState, name: string, patch: Partial<RoleConfig>): ConfigState {
  const roles = state.draft.roles.map((role) => (role.name === name ? { ...role, ...patch } : role));
  return withDraft(state, { ...state.draft, roles });
}

/** Déplace l'agent à `index` d'un cran dans l'ordre de repli du rôle. Sans effet si le mouvement sortirait de la liste. */
export function moveRoleAgent(state: ConfigState, roleName: string, index: number, direction: "up" | "down"): ConfigState {
  const role = findRole(state, roleName);
  if (!role) return state;
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= role.agents.length || target < 0 || target >= role.agents.length) return state;

  const agents = [...role.agents];
  const moved = agents[index]!;
  agents[index] = agents[target]!;
  agents[target] = moved;
  return updateRole(state, roleName, { agents });
}

/** Ajoute `agentId` en fin d'ordre de repli, s'il n'y est pas déjà. */
export function addRoleAgent(state: ConfigState, roleName: string, agentId: string): ConfigState {
  const role = findRole(state, roleName);
  if (!role || role.agents.includes(agentId)) return state;
  return updateRole(state, roleName, { agents: [...role.agents, agentId] });
}

/** Retire l'agent à `index` de l'ordre de repli du rôle. */
export function removeRoleAgentAt(state: ConfigState, roleName: string, index: number): ConfigState {
  const role = findRole(state, roleName);
  if (!role || index < 0 || index >= role.agents.length) return state;
  return updateRole(state, roleName, { agents: role.agents.filter((_, i) => i !== index) });
}

/**
 * Quel agent serait retenu aujourd'hui pour ce rôle, `installed` déjà
 * détecté par l'appelant (`App`, une seule fois au démarrage — voir le
 * brief : "n'appelle pas la détection à chaque frappe"). S'appuie sur
 * `pickAgentForRole` (`@orch/core`) — c'est la seule règle de repli, elle ne
 * se réécrit pas ici (voir le brief : "il doit... s'appuyer sur
 * pickAgentForRole"). `null` si le rôle n'existe pas (plus dans `draft`, p.
 * ex. après suppression).
 */
export function pickAgentForRoleName(
  state: ConfigState,
  roleName: string,
  installed: Map<string, boolean>,
): (AgentPick | { error: string }) | null {
  const role = findRole(state, roleName);
  if (!role) return null;
  return pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: state.draft.policy });
}
