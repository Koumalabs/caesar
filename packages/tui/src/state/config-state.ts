/**
 * Loading, editing scope, pending changes and saving of the configuration
 * — the heart of the TUI, deliberately free of any rendering: each screen
 * merely calls these functions and displays the result.
 *
 * `@caesar/core` remains the single source of truth (`loadConfig`,
 * `loadLayer`, `saveLayer`, `materializeListEdit`): this module neither
 * rereads nor rewrites the TOML itself, and reimplements no merge or
 * materialization rule — see the brief of task 15, which replaces the
 * provisional fix of task 13 (that one always flattened the whole merge
 * into the project layer, exactly the I11 defect already fixed on the CLI
 * side).
 *
 * Three things to keep apart, from now on:
 *  - `layers`: the three layers as loaded from disk
 *    (`loadConfig(...).layers`) — never modified anywhere except at load
 *    time or after a successful save (which only touches the active
 *    layer's entry).
 *  - `activeScope`: the layer being edited, the one "s" will save.
 *  - `draft`: the working copy of the active layer — exactly what this
 *    layer will declare if saved now, never a complete `CaesarConfig`.
 *
 * The display never reads `draft` directly: `effectiveConfig` recomputes
 * the merge (`mergeConfig`, `@caesar/core`) substituting `draft` for the
 * active layer in `layers`, exactly the merge a save would produce. That
 * is what lets a field not yet overridden by the active layer keep
 * showing its inherited value until it is modified.
 *
 * All mutations are pure: they take a `ConfigState` and return a new one,
 * without ever touching the disk. Only `saveConfigState` writes, and only
 * `loadConfigState` reads — and neither is ever called without an
 * explicit user action (`s` to save, never a modification keystroke).
 */
import type {
  ConfigLayer,
  ConfigOverride,
  ConfigScope,
  GenericAgentSpec,
  CaesarConfig,
  PolicyConfig,
  ProvenanceSource,
  RoleConfig,
} from "@caesar/core";
import {
  agentProvenance,
  configPathFor,
  loadConfig,
  materializeListEdit,
  mergeConfig,
  modelProvenance,
  pickAgentForRole,
  policyFieldProvenance,
  roleProvenance,
  defaultConfig as coreDefaultConfig,
  saveLayer,
} from "@caesar/core";
import type { AgentPick } from "@caesar/core";

/** The three layers, from most general to most specific — same order as `@caesar/core` (`loadConfig`). */
export const CONFIG_SCOPES: readonly ConfigScope[] = ["global", "project", "local"];

export interface ConfigState {
  /** The three layers as loaded from disk (see this file's header). */
  layers: ConfigLayer[];
  /** The edited layer: the one `draft` carries, and that `saveConfigState` will save. */
  activeScope: ConfigScope;
  /** Working copy of the active layer — never a complete `CaesarConfig`, see this file's header. */
  draft: ConfigOverride;
}

/** Structural comparison by value — same pattern as `packages/cli/src/commands/policy.ts` (`sameValue`). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findLayer(layers: readonly ConfigLayer[], scope: ConfigScope): ConfigLayer {
  const layer = layers.find((l) => l.scope === scope);
  if (!layer) throw new Error(`Layer "${scope}" missing from the loaded state (internal bug: loadConfig must always return all three layers).`);
  return layer;
}

/** `layers`, with the active layer replaced by `draft` — exactly what a save would produce. */
function layersWithDraft(state: ConfigState): ConfigLayer[] {
  return state.layers.map((layer) => (layer.scope === state.activeScope ? { ...layer, override: state.draft } : layer));
}

/**
 * The effective merge to display: `defaultConfig()` merged layer by layer
 * (`mergeConfig`, `@caesar/core`), with the active layer carrying `draft`
 * rather than its last saved version. Sole source of truth for the
 * display — no screen must read `state.draft` to display a value, only to
 * know whether a field belongs to the active layer itself (inheritance
 * marks, permission to delete).
 */
export function effectiveConfig(state: ConfigState): CaesarConfig {
  return layersWithDraft(state).reduce((config, layer) => mergeConfig(config, layer.override), coreDefaultConfig());
}

/** True if there are unsaved changes on the active layer — the permanent indicator the brief demands. */
export function isDirty(state: ConfigState): boolean {
  return !sameValue(findLayer(state.layers, state.activeScope).override, state.draft);
}

export async function loadConfigState(root: string, activeScope: ConfigScope = "project"): Promise<ConfigState> {
  const { layers } = await loadConfig(root);
  return { layers, activeScope, draft: findLayer(layers, activeScope).override };
}

/**
 * Saves `draft` onto the active layer (`saveLayer`, `@caesar/core`) — the
 * only layer this module ever writes in the same gesture — then makes
 * `draft` the new known version of that layer: `isDirty` becomes false
 * again, `layers` remains the source for the two other layers (unchanged).
 */
export async function saveConfigState(root: string, state: ConfigState): Promise<ConfigState> {
  await saveLayer(state.activeScope, root, state.draft);
  const layers = state.layers.map((layer) =>
    layer.scope === state.activeScope ? { ...layer, override: state.draft } : layer,
  );
  return { ...state, layers };
}

/**
 * Changes the active layer. Always pure: it never decides on its own
 * whether pending changes must be confirmed before being discarded — it
 * is `App` that asks the question (same principle as the quit
 * confirmation), and only calls this function once the answer is in. The
 * new active layer restarts from its last saved version (`layers`), never
 * from the old layer's `draft`.
 */
export function setScope(state: ConfigState, scope: ConfigScope): ConfigState {
  return { ...state, activeScope: scope, draft: findLayer(state.layers, scope).override };
}

/** The next layer in the order global → project → local → global, for the key that cycles the scope. */
export function nextScope(scope: ConfigScope): ConfigScope {
  const index = CONFIG_SCOPES.indexOf(scope);
  return CONFIG_SCOPES[(index + 1) % CONFIG_SCOPES.length]!;
}

function withDraft(state: ConfigState, draft: ConfigOverride): ConfigState {
  return { ...state, draft };
}

// ---------------------------------------------------------------------------
// Provenance and inheritance marks
// ---------------------------------------------------------------------------

const SCOPE_RANK: Record<ConfigScope, number> = { global: 0, project: 1, local: 2 };

function rankOf(source: ProvenanceSource): number {
  return source === "default" ? -1 : SCOPE_RANK[source];
}

/**
 * `source` (a provenance returned by `@caesar/core`) if it comes from a
 * layer less specific than `state`'s active layer — hence from a value
 * that editing this field now would override —, otherwise `null`. This is
 * the inheritance mark (`← global`) the brief demands: it disappears as
 * soon as the active layer declares the field itself, since there is
 * nothing left to override.
 */
export function inheritedMark(state: ConfigState, source: ProvenanceSource): ProvenanceSource | null {
  return rankOf(source) < SCOPE_RANK[state.activeScope] ? source : null;
}

/** Provenance of a `policy` field, computed on `layers` with `draft` substituted (see `layersWithDraft`). */
export function policyProvenance(state: ConfigState, field: keyof PolicyConfig): ProvenanceSource {
  return policyFieldProvenance(layersWithDraft(state), field);
}

/** Inheritance mark of a `policy` field, `null` if the active layer already declares it (or more specific). */
export function policyFieldMark(state: ConfigState, field: keyof PolicyConfig): ProvenanceSource | null {
  return inheritedMark(state, policyProvenance(state, field));
}

/** Provenance of a role by name, computed on `layers` with `draft` substituted. */
export function roleProvenanceOf(state: ConfigState, name: string): ProvenanceSource {
  return roleProvenance(layersWithDraft(state), name);
}

/** Inheritance mark of a role, `null` if the active layer already declares it (or more specific). */
export function roleMark(state: ConfigState, name: string): ProvenanceSource | null {
  return inheritedMark(state, roleProvenanceOf(state, name));
}

/** True if the active layer declares this role itself — the condition for deleting it (see `removeRole`, and `caesar role remove`). */
export function roleDeclaredByActiveLayer(state: ConfigState, name: string): boolean {
  return (state.draft.roles ?? []).some((role) => role.name === name);
}

// ---------------------------------------------------------------------------
// Agents: permission (the policy's "denied" list)
// ---------------------------------------------------------------------------

export type PolicyListField = "allowed" | "denied";

/**
 * Adds or removes `agentId` from `allowed`/`denied`, on the active layer.
 * The computation (base = the **effective** list, not only what `draft`
 * already carries) is that of `materializeListEdit` (`@caesar/core`) — the
 * same rule as `caesar policy allow|deny`/`caesar agents enable|disable`,
 * never reimplemented here (see this file's header).
 */
export function setPolicyListEntry(state: ConfigState, field: PolicyListField, agentId: string, present: boolean): ConfigState {
  const effective = effectiveConfig(state).policy[field];
  const current = state.draft.policy?.[field];
  const { effective: next } = materializeListEdit(effective, current, agentId, present);
  return withDraft(state, { ...state.draft, policy: { ...state.draft.policy, [field]: next } });
}

/** Toggles an agent's permission — present in "denied" ⇔ denied, exactly the rule of `isAgentAllowed` (`@caesar/core`). */
export function toggleAgentDenied(state: ConfigState, agentId: string): ConfigState {
  const currentlyDenied = effectiveConfig(state).policy.denied.includes(agentId);
  return setPolicyListEntry(state, "denied", agentId, !currentlyDenied);
}

// ---------------------------------------------------------------------------
// Agents: declaration (`[[agent]]`)
//
// Allowing an agent and *declaring* an agent are two different things, and
// that is the distinction this section carries: the first only writes a
// policy list (just above), the second adds an `[[agent]]` entry that
// extends the catalog. Everything here mirrors the Roles section below —
// same merge by key, same limit on deleting an inherited entry, same
// names — because it is exactly the same configuration mechanics, applied
// to `agents` instead of `roles`.
// ---------------------------------------------------------------------------

/** The declared agent as it would display after saving (effective merge). `undefined` for a native catalog agent, which no layer declares. */
export function findAgentSpec(state: ConfigState, id: string): GenericAgentSpec | undefined {
  return effectiveConfig(state).agents.find((agent) => agent.id === id);
}

/** Provenance of an agent declaration, computed on `layers` with `draft` substituted. "default" for native agents. */
export function agentProvenanceOf(state: ConfigState, id: string): ProvenanceSource {
  return agentProvenance(layersWithDraft(state), id);
}

/** Inheritance mark of an agent declaration, `null` if the active layer already declares it (or more specific). */
export function agentMark(state: ConfigState, id: string): ProvenanceSource | null {
  return inheritedMark(state, agentProvenanceOf(state, id));
}

/** True if the active layer declares this agent itself — the condition for removing it (see `removeAgentSpec`, and `caesar agents remove`). */
export function agentDeclaredByActiveLayer(state: ConfigState, id: string): boolean {
  return (state.draft.agents ?? []).some((agent) => agent.id === id);
}

/** Writes `spec` in full into the active layer, replacing the entry with the same `id` if there is one — `mergeConfig`'s merge by key, like for roles. */
export function upsertAgentSpec(state: ConfigState, spec: GenericAgentSpec): ConfigState {
  const agents = [...(state.draft.agents ?? []).filter((agent) => agent.id !== spec.id), spec];
  return withDraft(state, { ...state.draft, agents });
}

/**
 * Modifies an existing declaration. No effect on a native catalog agent:
 * there is no `GenericAgentSpec` to modify — replacing it is done by
 * declaring it (`upsertAgentSpec`), a gesture far heavier in
 * consequences, which the caller must request explicitly.
 */
export function updateAgentSpec(state: ConfigState, id: string, patch: Partial<GenericAgentSpec>): ConfigState {
  const current = findAgentSpec(state, id);
  if (!current) return state;
  return upsertAgentSpec(state, { ...current, ...patch });
}

/**
 * Removes a declaration — only if the active layer carries it itself.
 * Same limit as `removeRole` and `caesar agents remove`: the merge by key
 * cannot express the deletion of an inherited entry. No effect otherwise:
 * it is up to the caller to check `agentDeclaredByActiveLayer` beforehand
 * to explain it rather than letting the key do nothing.
 */
export function removeAgentSpec(state: ConfigState, id: string): ConfigState {
  if (!agentDeclaredByActiveLayer(state, id)) return state;
  return withDraft(state, { ...state.draft, agents: (state.draft.agents ?? []).filter((agent) => agent.id !== id) });
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * `policy` merges field by field (see `mergeConfig`, `@caesar/core`):
 * unlike the lists, a scalar field is written directly into
 * `draft.policy`, with no "effective" base to recompute — writing it is
 * enough for it to take over that precise field, without touching the
 * others.
 */
export function updatePolicy(state: ConfigState, patch: Partial<PolicyConfig>): ConfigState {
  return withDraft(state, { ...state.draft, policy: { ...state.draft.policy, ...patch } });
}

// ---------------------------------------------------------------------------
// Default model per agent (`[models]`)
// ---------------------------------------------------------------------------

/**
 * Sets (or, with `undefined`, removes) the active layer's default model for
 * `agentId`. Key by key like `updatePolicy` — never `materializeListEdit`,
 * which serves the whole-list replacement of `allowed`/`denied`: in a
 * key-by-key merge, writing one key is enough to take it over, and an
 * emptied table can mask nothing, so it leaves the draft entirely rather
 * than staying behind as dead weight in the file. Removing a key declared
 * by a *less specific* layer does not hide it — the inherited value
 * reappears in the merge, the same limit as inherited roles: the caller
 * explains it on screen rather than working around it here.
 */
export function updateModel(state: ConfigState, agentId: string, model: string | undefined): ConfigState {
  const models = { ...state.draft.models };
  if (model === undefined) delete models[agentId];
  else models[agentId] = model;
  const draft = { ...state.draft };
  if (Object.keys(models).length > 0) draft.models = models;
  else delete draft.models;
  return withDraft(state, draft);
}

/** Provenance of an agent's default model (per key — see `modelProvenance`, `@caesar/core`), computed on `layers` with `draft` substituted. */
export function modelProvenanceOf(state: ConfigState, agentId: string): ProvenanceSource {
  return modelProvenance(layersWithDraft(state), agentId);
}

/** Inheritance mark of an agent's default model, `null` if the active layer already declares the key itself. */
export function modelMark(state: ConfigState, agentId: string): ProvenanceSource | null {
  return inheritedMark(state, modelProvenanceOf(state, agentId));
}

/** True if the active layer declares this agent's default model itself — the condition for removing it from here (see `updateModel`). */
export function modelDeclaredByActiveLayer(state: ConfigState, agentId: string): boolean {
  return state.draft.models?.[agentId] !== undefined;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** The role as it would display after saving (effective merge) — never `state.draft.roles` alone, which only carries what the active layer declares. */
export function findRole(state: ConfigState, name: string): RoleConfig | undefined {
  return effectiveConfig(state).roles.find((role) => role.name === name);
}

/**
 * Writes `role` in full into the active layer, replacing the existing
 * entry with the same `name` if there is one — exactly `mergeConfig`'s
 * merge by key (a role has no "fields" that materialize separately the
 * way `policy` does: the whole entry moves to the active layer as soon as
 * one field changes, the same rule `caesar role add` already applies). A
 * layer that did not yet declare this role (inherited) now takes it over
 * in full.
 */
function putRoleInDraft(state: ConfigState, role: RoleConfig): ConfigState {
  const roles = [...(state.draft.roles ?? []).filter((r) => r.name !== role.name), role];
  return withDraft(state, { ...state.draft, roles });
}

/** Creates a role (if `role.name` is new) or replaces it entirely on the active layer (if it already exists, inherited included) — same semantics as `caesar role add`. */
export function upsertRole(state: ConfigState, role: RoleConfig): ConfigState {
  return putRoleInDraft(state, role);
}

/**
 * Removes a role — only if it is declared by the active layer itself
 * (`roleDeclaredByActiveLayer`): the merge by key cannot express the
 * deletion of a role inherited from a less specific layer, exactly the
 * limit already set by `caesar role remove`
 * (`packages/cli/src/commands/role.ts`). No effect if the role is not
 * declared here — it is up to the caller to check
 * `roleDeclaredByActiveLayer` beforehand to warn the user rather than
 * letting the "x" key do nothing without explanation.
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

/**
 * Renames a role on the active layer — the only mutation that *removes* a
 * key in addition to writing one, hence the same reservation as
 * `removeRole`: without a declaration by the active layer, the old name
 * would keep existing, inherited from the layer below, and one would end
 * up with two roles where one believed one was being renamed. No effect
 * in that case — it is up to the caller to check
 * `roleDeclaredByActiveLayer` to explain it.
 */
export function renameRole(state: ConfigState, from: string, to: string): ConfigState {
  if (!roleDeclaredByActiveLayer(state, from)) return state;
  const current = findRole(state, from);
  if (!current) return state;
  const roles = (state.draft.roles ?? []).filter((role) => role.name !== from && role.name !== to);
  return withDraft(state, { ...state.draft, roles: [...roles, { ...current, name: to }] });
}

/** Moves the agent at `index` one notch in the role's fallback order. No effect if the move would leave the list. */
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

/** Adds `agentId` at the end of the fallback order, if it is not already there. */
export function addRoleAgent(state: ConfigState, roleName: string, agentId: string): ConfigState {
  const role = findRole(state, roleName);
  if (!role || role.agents.includes(agentId)) return state;
  return updateRole(state, roleName, { agents: [...role.agents, agentId] });
}

/** Removes the agent at `index` from the role's fallback order. */
export function removeRoleAgentAt(state: ConfigState, roleName: string, index: number): ConfigState {
  const role = findRole(state, roleName);
  if (!role || index < 0 || index >= role.agents.length) return state;
  return updateRole(state, roleName, { agents: role.agents.filter((_, i) => i !== index) });
}

/**
 * Which agent would be picked today for this role, `installed` already
 * detected by the caller (`App`, once at startup — see the brief: "does
 * not call detection on every keystroke"). Relies on `pickAgentForRole`
 * (`@caesar/core`) — it is the only fallback rule, it is not rewritten
 * here (see the brief: "it must... rely on pickAgentForRole"). `null` if
 * the role does not exist (no longer in the effective merge, e.g. after
 * deletion).
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
// Scope labels — purely presentational (see the brief: the scope selector
// is the most important piece of information on the screen).
// ---------------------------------------------------------------------------

const SCOPE_LABELS: Record<ConfigScope, string> = { global: "global", project: "project", local: "local" };
const SCOPE_MARK_LABELS: Record<ProvenanceSource, string> = { default: "default", global: "global", project: "project", local: "local" };

/** Human label of a layer, for the status bar (never reimported from `packages/cli/src/scope.ts`, which the TUI does not depend on — see the header note of `IntegrationsScreen.tsx`). */
export function scopeLabel(scope: ConfigScope): string {
  return SCOPE_LABELS[scope];
}

/** Path of the active layer's file — for the save confirmation messages. */
export function activeScopePath(root: string, state: ConfigState): string {
  return configPathFor(state.activeScope, root);
}

/** Text of the inheritance mark (`← global`), empty if `source` is `null` (nothing to report). */
export function formatInheritedMark(source: ProvenanceSource | null): string {
  return source ? ` ← ${SCOPE_MARK_LABELS[source]}` : "";
}
