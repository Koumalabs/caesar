/**
 * Chargement, portée d'édition, modifications en attente et enregistrement
 * de la configuration — le cœur du TUI, volontairement sans aucun rendu :
 * chaque écran ne fait qu'appeler ces fonctions et afficher le résultat.
 *
 * `@orch/core` reste la seule source de vérité (`loadConfig`, `loadLayer`,
 * `saveLayer`, `materializeListEdit`) : ce module ne relit ni ne réécrit le
 * TOML lui-même, et ne réimplémente aucune règle de fusion ou de
 * matérialisation — voir le brief de la tâche 15, qui remplace le correctif
 * provisoire de la tâche 13 (celui-ci aplatissait toujours la fusion entière
 * dans la couche projet, exactement le défaut I11 déjà corrigé côté CLI).
 *
 * Trois choses à distinguer, désormais :
 *  - `layers` : les trois couches telles que chargées depuis le disque
 *    (`loadConfig(...).layers`) — jamais modifiées ailleurs qu'au chargement
 *    ou après un enregistrement réussi (qui ne touche que l'entrée de la
 *    couche active).
 *  - `activeScope` : la couche qu'on édite, celle que "s" enregistrera.
 *  - `draft` : la copie de travail de la couche active — exactement ce que
 *    cette couche déclarera si on enregistre maintenant, jamais un
 *    `OrchConfig` complet.
 *
 * L'affichage ne lit jamais `draft` directement : `effectiveConfig` recalcule
 * la fusion (`mergeConfig`, `@orch/core`) en substituant `draft` à la couche
 * active dans `layers`, exactement la fusion qu'un enregistrement produirait.
 * C'est ce qui permet à un champ non encore surchargé par la couche active de
 * continuer à afficher sa valeur héritée tant qu'on ne l'a pas modifié.
 *
 * Toutes les mutations sont pures : elles reçoivent un `ConfigState` et en
 * renvoient un nouveau, sans jamais toucher au disque. Seul `saveConfigState`
 * écrit, et seul `loadConfigState` lit — et aucune des deux n'est jamais
 * appelée sans une action explicite de l'utilisateur (`s` pour enregistrer,
 * jamais une frappe de modification).
 */
import type { ConfigLayer, ConfigOverride, ConfigScope, OrchConfig, PolicyConfig, ProvenanceSource, RoleConfig } from "@orch/core";
import {
  configPathFor,
  loadConfig,
  materializeListEdit,
  mergeConfig,
  pickAgentForRole,
  policyFieldProvenance,
  roleProvenance,
  defaultConfig as coreDefaultConfig,
  saveLayer,
} from "@orch/core";
import type { AgentPick } from "@orch/core";

/** Les trois couches, du plus général au plus spécifique — même ordre que `@orch/core` (`loadConfig`). */
export const CONFIG_SCOPES: readonly ConfigScope[] = ["global", "project", "local"];

export interface ConfigState {
  /** Les trois couches telles que chargées depuis le disque (voir l'en-tête de ce fichier). */
  layers: ConfigLayer[];
  /** La couche éditée : celle que `draft` porte, et que `saveConfigState` enregistrera. */
  activeScope: ConfigScope;
  /** Copie de travail de la couche active — jamais un `OrchConfig` complet, voir l'en-tête de ce fichier. */
  draft: ConfigOverride;
}

/** Comparaison structurelle par valeur — même motif que `packages/cli/src/commands/policy.ts` (`sameValue`). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findLayer(layers: readonly ConfigLayer[], scope: ConfigScope): ConfigLayer {
  const layer = layers.find((l) => l.scope === scope);
  if (!layer) throw new Error(`Couche "${scope}" absente de l'état chargé (bug interne : loadConfig doit toujours rendre les trois couches).`);
  return layer;
}

/** `layers`, avec la couche active remplacée par `draft` — exactement ce qu'un enregistrement produirait. */
function layersWithDraft(state: ConfigState): ConfigLayer[] {
  return state.layers.map((layer) => (layer.scope === state.activeScope ? { ...layer, override: state.draft } : layer));
}

/**
 * La fusion effective à afficher : `defaultConfig()` fusionnée couche par
 * couche (`mergeConfig`, `@orch/core`), la couche active portant `draft`
 * plutôt que sa dernière version enregistrée. Seule source de vérité pour
 * l'affichage — aucun écran ne doit lire `state.draft` pour afficher une
 * valeur, seulement pour savoir si un champ est en propre à la couche active
 * (marques d'héritage, permission de suppression).
 */
export function effectiveConfig(state: ConfigState): OrchConfig {
  return layersWithDraft(state).reduce((config, layer) => mergeConfig(config, layer.override), coreDefaultConfig());
}

/** Vrai s'il existe des modifications non enregistrées sur la couche active — l'indicateur permanent que le brief demande. */
export function isDirty(state: ConfigState): boolean {
  return !sameValue(findLayer(state.layers, state.activeScope).override, state.draft);
}

export async function loadConfigState(root: string, activeScope: ConfigScope = "project"): Promise<ConfigState> {
  const { layers } = await loadConfig(root);
  return { layers, activeScope, draft: findLayer(layers, activeScope).override };
}

/**
 * Enregistre `draft` sur la couche active (`saveLayer`, `@orch/core`) — la
 * seule couche que ce module écrit jamais dans le même geste — puis fait de
 * `draft` la nouvelle version connue de cette couche : `isDirty` redevient
 * faux, `layers` reste la source pour les deux autres couches (inchangées).
 */
export async function saveConfigState(root: string, state: ConfigState): Promise<ConfigState> {
  await saveLayer(state.activeScope, root, state.draft);
  const layers = state.layers.map((layer) =>
    layer.scope === state.activeScope ? { ...layer, override: state.draft } : layer,
  );
  return { ...state, layers };
}

/**
 * Change la couche active. Toujours pure : ne décide jamais elle-même si des
 * modifications en attente doivent être confirmées avant de les abandonner —
 * c'est `App` qui pose la question (même principe que la confirmation de
 * sortie), et n'appelle cette fonction qu'une fois la réponse obtenue. La
 * nouvelle couche active repart de sa dernière version enregistrée
 * (`layers`), jamais de `draft` de l'ancienne couche.
 */
export function setScope(state: ConfigState, scope: ConfigScope): ConfigState {
  return { ...state, activeScope: scope, draft: findLayer(state.layers, scope).override };
}

/** La couche suivante dans l'ordre global → projet → local → global, pour la touche qui fait cycler la portée. */
export function nextScope(scope: ConfigScope): ConfigScope {
  const index = CONFIG_SCOPES.indexOf(scope);
  return CONFIG_SCOPES[(index + 1) % CONFIG_SCOPES.length]!;
}

function withDraft(state: ConfigState, draft: ConfigOverride): ConfigState {
  return { ...state, draft };
}

// ---------------------------------------------------------------------------
// Provenance et marques d'héritage
// ---------------------------------------------------------------------------

const SCOPE_RANK: Record<ConfigScope, number> = { global: 0, project: 1, local: 2 };

function rankOf(source: ProvenanceSource): number {
  return source === "default" ? -1 : SCOPE_RANK[source];
}

/**
 * `source` (une provenance rendue par `@orch/core`) si elle vient d'une
 * couche moins spécifique que la couche active de `state` — donc d'une
 * valeur qu'éditer ce champ maintenant surchargerait —, sinon `null`. C'est
 * la marque d'héritage (`← global`) que le brief demande : elle disparaît
 * dès que la couche active déclare elle-même le champ, puisqu'il n'y a plus
 * rien à surcharger.
 */
export function inheritedMark(state: ConfigState, source: ProvenanceSource): ProvenanceSource | null {
  return rankOf(source) < SCOPE_RANK[state.activeScope] ? source : null;
}

/** Provenance d'un champ de `policy`, calculée sur `layers` avec `draft` substitué (voir `layersWithDraft`). */
export function policyProvenance(state: ConfigState, field: keyof PolicyConfig): ProvenanceSource {
  return policyFieldProvenance(layersWithDraft(state), field);
}

/** Marque d'héritage d'un champ de `policy`, `null` si la couche active le déclare déjà (ou plus spécifique). */
export function policyFieldMark(state: ConfigState, field: keyof PolicyConfig): ProvenanceSource | null {
  return inheritedMark(state, policyProvenance(state, field));
}

/** Provenance d'un rôle par nom, calculée sur `layers` avec `draft` substitué. */
export function roleProvenanceOf(state: ConfigState, name: string): ProvenanceSource {
  return roleProvenance(layersWithDraft(state), name);
}

/** Marque d'héritage d'un rôle, `null` si la couche active le déclare déjà (ou plus spécifique). */
export function roleMark(state: ConfigState, name: string): ProvenanceSource | null {
  return inheritedMark(state, roleProvenanceOf(state, name));
}

/** Vrai si la couche active déclare ce rôle en propre — condition pour pouvoir le supprimer (voir `removeRole`, et `orch role remove`). */
export function roleDeclaredByActiveLayer(state: ConfigState, name: string): boolean {
  return (state.draft.roles ?? []).some((role) => role.name === name);
}

// ---------------------------------------------------------------------------
// Agents : autorisation (liste "denied" de la politique)
// ---------------------------------------------------------------------------

export type PolicyListField = "allowed" | "denied";

/**
 * Ajoute ou retire `agentId` de `allowed`/`denied`, sur la couche active. Le
 * calcul (base = liste **effective**, pas seulement ce que `draft` porte
 * déjà) est celui de `materializeListEdit` (`@orch/core`) — la même règle
 * que `orch policy allow|deny`/`orch agents enable|disable`, jamais
 * réimplémentée ici (voir l'en-tête de ce fichier).
 */
export function setPolicyListEntry(state: ConfigState, field: PolicyListField, agentId: string, present: boolean): ConfigState {
  const effective = effectiveConfig(state).policy[field];
  const current = state.draft.policy?.[field];
  const { effective: next } = materializeListEdit(effective, current, agentId, present);
  return withDraft(state, { ...state.draft, policy: { ...state.draft.policy, [field]: next } });
}

/** Bascule l'autorisation d'un agent — présent dans "denied" ⇔ refusé, exactement la règle d'`isAgentAllowed` (`@orch/core`). */
export function toggleAgentDenied(state: ConfigState, agentId: string): ConfigState {
  const currentlyDenied = effectiveConfig(state).policy.denied.includes(agentId);
  return setPolicyListEntry(state, "denied", agentId, !currentlyDenied);
}

// ---------------------------------------------------------------------------
// Politique
// ---------------------------------------------------------------------------

/**
 * `policy` se fusionne champ par champ (voir `mergeConfig`, `@orch/core`) :
 * contrairement aux listes, un champ scalaire s'écrit directement dans
 * `draft.policy`, sans base "effective" à recalculer — l'écrire suffit à le
 * faire prendre la main sur ce champ précis, sans toucher aux autres.
 */
export function updatePolicy(state: ConfigState, patch: Partial<PolicyConfig>): ConfigState {
  return withDraft(state, { ...state.draft, policy: { ...state.draft.policy, ...patch } });
}

// ---------------------------------------------------------------------------
// Rôles
// ---------------------------------------------------------------------------

/** Le rôle tel qu'il s'afficherait après enregistrement (fusion effective) — jamais `state.draft.roles` seul, qui ne porte que ce que la couche active déclare. */
export function findRole(state: ConfigState, name: string): RoleConfig | undefined {
  return effectiveConfig(state).roles.find((role) => role.name === name);
}

/**
 * Écrit `role` en entier dans la couche active, en remplaçant l'entrée
 * existante de même `name` s'il y en a une — exactement la fusion par clé de
 * `mergeConfig` (un rôle n'a pas de "champs" qui se matérialisent séparément
 * comme `policy` : toute l'entrée bascule sur la couche active dès qu'on en
 * change un champ, la même règle que `orch role add` applique déjà). Une
 * couche qui ne déclarait pas encore ce rôle (hérité) le prend désormais en
 * charge en entier.
 */
function putRoleInDraft(state: ConfigState, role: RoleConfig): ConfigState {
  const roles = [...(state.draft.roles ?? []).filter((r) => r.name !== role.name), role];
  return withDraft(state, { ...state.draft, roles });
}

/** Crée un rôle (si `role.name` est nouveau) ou le remplace entièrement sur la couche active (s'il existe déjà, y compris hérité) — même sémantique que `orch role add`. */
export function upsertRole(state: ConfigState, role: RoleConfig): ConfigState {
  return putRoleInDraft(state, role);
}

/**
 * Retire un rôle — seulement s'il est déclaré par la couche active elle-même
 * (`roleDeclaredByActiveLayer`) : la fusion par clé ne sait pas exprimer une
 * suppression d'un rôle hérité d'une couche moins spécifique, exactement la
 * limite déjà posée par `orch role remove` (`packages/cli/src/commands/role.ts`).
 * Sans effet si le rôle n'est pas déclaré ici — à l'appelant de vérifier
 * `roleDeclaredByActiveLayer` au préalable pour prévenir l'utilisateur
 * plutôt que de laisser la touche "x" ne rien faire sans explication.
 */
export function removeRole(state: ConfigState, name: string): ConfigState {
  if (!roleDeclaredByActiveLayer(state, name)) return state;
  return withDraft(state, { ...state.draft, roles: (state.draft.roles ?? []).filter((role) => role.name !== name) });
}

export function updateRole(state: ConfigState, name: string, patch: Partial<RoleConfig>): ConfigState {
  const current = findRole(state, name);
  if (!current) return state;
  return putRoleInDraft(state, { ...current, ...patch });
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
 * pickAgentForRole"). `null` si le rôle n'existe pas (plus dans la fusion
 * effective, p. ex. après suppression).
 */
export function pickAgentForRoleName(
  state: ConfigState,
  roleName: string,
  installed: Map<string, boolean>,
): (AgentPick | { error: string }) | null {
  const role = findRole(state, roleName);
  if (!role) return null;
  return pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: effectiveConfig(state).policy });
}

// ---------------------------------------------------------------------------
// Étiquettes de portée — purement présentationnelles (voir le brief : le
// sélecteur de portée est l'information la plus importante de l'écran).
// ---------------------------------------------------------------------------

const SCOPE_LABELS: Record<ConfigScope, string> = { global: "globale", project: "projet", local: "locale" };
const SCOPE_MARK_LABELS: Record<ProvenanceSource, string> = { default: "défaut", global: "global", project: "projet", local: "local" };

/** Libellé humain d'une couche, pour la barre d'état (jamais réimporté de `packages/cli/src/scope.ts`, dont le TUI ne dépend pas — voir la note de tête de `IntegrationsScreen.tsx`). */
export function scopeLabel(scope: ConfigScope): string {
  return SCOPE_LABELS[scope];
}

/** Chemin du fichier de la couche active — pour les messages de confirmation d'enregistrement. */
export function activeScopePath(root: string, state: ConfigState): string {
  return configPathFor(state.activeScope, root);
}

/** Texte de la marque d'héritage (`← global`), vide si `source` est `null` (rien à signaler). */
export function formatInheritedMark(source: ProvenanceSource | null): string {
  return source ? ` ← ${SCOPE_MARK_LABELS[source]}` : "";
}
