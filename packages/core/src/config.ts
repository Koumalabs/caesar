/**
 * Configuration de l'orchestrateur : schéma, chargement, fusion et écriture.
 *
 * Trois emplacements sur disque, fusionnés au chargement dans cet ordre — le
 * plus spécifique l'emportant, champ par champ :
 *   - global  : `~/.config/orch/config.toml`               (non versionné, propre au poste)
 *   - projet  : `<root>/.orch/config.toml`                 (versionné, partagé avec l'équipe)
 *   - local   : `<root>/.orch/config.local.toml`            (non versionné, propre au poste — à ajouter au `.gitignore`)
 *
 * `@orch/core` est la seule source de vérité de cette configuration (voir
 * les contraintes globales du projet) : aucune façade (CLI, TUI, serveur
 * MCP) ne doit relire ni réécrire le TOML pour son propre compte, elles
 * passent toutes par ce module.
 *
 * La fusion (`mergeConfig`, appelée par `loadConfig`) reste la seule source
 * de vérité de ce qu'un consommateur (moteur, serveur MCP, rôles, politique)
 * doit lire — `loadConfig(...).config`. L'**écriture**, elle, ne doit jamais
 * réécrire le résultat de cette fusion dans une seule couche : ce serait y
 * figer les valeurs de toutes les couches moins spécifiques, qui perdraient
 * alors tout effet (c'était le défaut I11 de la revue finale de branche).
 * `loadLayer`/`saveLayer` donnent donc accès à une couche précise, isolée de
 * la fusion : un fichier absent rend un `ConfigOverride` vide, jamais une
 * erreur ni des valeurs par défaut, et `saveLayer` ne sérialise que ce que
 * l'appelant lui donne explicitement — jamais plus que ce que la couche doit
 * déclarer.
 *
 * La configuration est un fichier édité à la main : les erreurs de
 * validation nomment systématiquement le fichier et le champ en cause, et
 * un fichier absent n'est jamais une erreur (voir `loadConfig`).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ZodIssue } from "zod";
import { z } from "zod";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import type { Isolation, TaskMode } from "@orch/protocol";
import { TaskModeSchema } from "@orch/protocol";
import type { GenericAgentSpec } from "./registry/generic.js";

export interface PolicyConfig {
  allowed: string[];
  denied: string[];
  max_parallel: number;
  default_isolation: Isolation | "auto";
  default_mode: TaskMode;
  default_timeout_ms: number;
  allow_recursion: boolean;
  max_depth: number;
}

export interface RoleConfig {
  name: string;
  purpose: string;
  agents: string[];
  mode: TaskMode;
  isolation: Isolation | "auto";
  timeout_ms: number;
  system_prompt_file?: string;
}

export interface OrchConfig {
  policy: PolicyConfig;
  roles: RoleConfig[];
  agents: GenericAgentSpec[];
}

/**
 * Une contribution à fusionner dans un `OrchConfig` de base — ce que `mergeConfig`
 * accepte comme `override`, et ce qu'un seul fichier de configuration (global ou
 * projet) apporte une fois parsé.
 *
 * `policy` est volontairement `Partial<PolicyConfig>`, pas `PolicyConfig` :
 * `Partial<OrchConfig>` ne l'aurait rendu superficiellement optionnel qu'au
 * niveau de `policy` lui-même, en exigeant qu'il soit complet dès qu'il est
 * présent — alors que la fusion voulue (et testée) est champ par champ. `roles`
 * et `agents` restent des listes d'entrées complètes : ces deux-là se
 * fusionnent par clé, avec remplacement entier de l'entrée (voir `mergeConfig`),
 * pas champ par champ.
 */
export interface ConfigOverride {
  policy?: Partial<PolicyConfig>;
  roles?: RoleConfig[];
  agents?: GenericAgentSpec[];
}

/** Les trois couches, du plus général au plus spécifique — voir l'en-tête de ce module. */
export type ConfigScope = "global" | "project" | "local";

/** Une couche telle qu'elle existe sur disque : `override` est exactement ce que le fichier déclare, jamais le résultat d'une fusion (voir `loadLayer`). */
export interface ConfigLayer {
  scope: ConfigScope;
  path: string;
  override: ConfigOverride;
}

export interface LoadedConfig {
  config: OrchConfig;
  /** Les trois couches, dans l'ordre d'application (global, projet, local) — y compris celles dont le fichier est absent (`override` vide alors). */
  layers: ConfigLayer[];
  sources: { global?: string; project?: string; local?: string };
  /**
   * Réservé aux avertissements non bloquants (fichier chargé mais
   * comportant une incohérence mineure). Aucune condition de ce type n'est
   * encore produite par cette tâche : toujours vide pour l'instant.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Durées
// ---------------------------------------------------------------------------

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)?$/;
const DURATION_FACTORS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const DURATION_HELP = 'formes acceptées : "10m", "90s", "1h", ou un entier de millisecondes';

/** Convertit une durée TOML ("10m", "90s", "1h", ou un entier de millisecondes) en millisecondes. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Durée invalide : ${value} (${DURATION_HELP})`);
    }
    return Math.trunc(value);
  }
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match || !match[1]) {
    throw new Error(`Durée invalide : "${value}" (${DURATION_HELP})`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  return amount * DURATION_FACTORS[unit]!;
}

// ---------------------------------------------------------------------------
// Schéma brut : la forme telle qu'elle apparaît dans le TOML
// ---------------------------------------------------------------------------

const DurationInputSchema = z.union([z.string(), z.number()]);

/** Durée TOML obligatoire, avec une valeur par défaut si le champ est absent. */
function requiredDurationMsSchema(defaultValue: string | number) {
  return DurationInputSchema.default(defaultValue).transform((value, ctx) => {
    try {
      return parseDuration(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  });
}

/**
 * Durée TOML facultative, qui reste `undefined` si le champ est absent —
 * utilisée uniquement pour `policy`, dont les champs se fusionnent un par un
 * entre le global et le projet (voir `mergeConfig`) : un champ absent d'un
 * fichier ne doit jamais écraser la valeur de l'autre par une valeur par
 * défaut appliquée trop tôt.
 */
function optionalDurationMsSchema() {
  return DurationInputSchema.optional().transform((value, ctx) => {
    if (value === undefined) return undefined;
    try {
      return parseDuration(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  });
}

const IsolationOrAutoSchema = z.enum(["inplace", "worktree", "auto"]);

/**
 * `[policy]` : chaque champ reste facultatif ici. Un fichier qui ne
 * mentionne pas un champ ne dit rien à son sujet — c'est `mergeConfig` qui
 * décide, en le retombant sur la couche précédente (global, puis
 * `defaultConfig()`). Défaulter ce champ ici referait perdre cette
 * distinction entre « absent » et « explicitement mis à la valeur par
 * défaut ».
 */
const RawPolicySchema = z
  .object({
    allowed: z.array(z.string()).optional(),
    denied: z.array(z.string()).optional(),
    max_parallel: z.number().int().positive().optional(),
    default_isolation: IsolationOrAutoSchema.optional(),
    default_mode: TaskModeSchema.optional(),
    default_timeout: optionalDurationMsSchema(),
    allow_recursion: z.boolean().optional(),
    max_depth: z.number().int().nonnegative().optional(),
  })
  .strict();
type RawPolicy = z.infer<typeof RawPolicySchema>;

/**
 * `[[role]]` : à l'inverse de `policy`, un rôle du projet qui porte le même
 * `name` qu'un rôle global remplace ce dernier **entièrement** (fusion par
 * clé, pas champ par champ — voir `mergeConfig`). Chaque entrée doit donc
 * être complète par elle-même ; ses champs par défaut sont donc appliqués
 * ici, localement à l'entrée.
 */
const RawRoleSchema = z
  .object({
    name: z.string().min(1),
    purpose: z.string().default(""),
    agents: z.array(z.string()),
    mode: TaskModeSchema,
    isolation: IsolationOrAutoSchema.default("auto"),
    timeout: requiredDurationMsSchema("10m"),
    system_prompt_file: z.string().optional(),
  })
  .strict();
type RawRole = z.infer<typeof RawRoleSchema>;

/** `[[agent]]` : agent personnalisé, cf. `GenericAgentSpec`. Fusion par clé (`id`), même logique que les rôles. */
const RawAgentSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1).optional(),
    bin: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd_mode: z.enum(["process", "flag"]).optional(),
  })
  .strict();
type RawAgent = z.infer<typeof RawAgentSchema>;

const RawFileSchema = z
  .object({
    policy: RawPolicySchema.optional(),
    role: z.array(RawRoleSchema).default([]),
    agent: z.array(RawAgentSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Conversions entre la forme brute (TOML) et la forme applicative (OrchConfig)
// ---------------------------------------------------------------------------

/** Ne garde que les champs effectivement présents : c'est ce qui rend la fusion `policy` champ par champ possible. */
function toPolicyOverride(raw: RawPolicy): Partial<PolicyConfig> {
  const override: Partial<PolicyConfig> = {};
  if (raw.allowed !== undefined) override.allowed = raw.allowed;
  if (raw.denied !== undefined) override.denied = raw.denied;
  if (raw.max_parallel !== undefined) override.max_parallel = raw.max_parallel;
  if (raw.default_isolation !== undefined) override.default_isolation = raw.default_isolation;
  if (raw.default_mode !== undefined) override.default_mode = raw.default_mode;
  if (raw.default_timeout !== undefined) override.default_timeout_ms = raw.default_timeout;
  if (raw.allow_recursion !== undefined) override.allow_recursion = raw.allow_recursion;
  if (raw.max_depth !== undefined) override.max_depth = raw.max_depth;
  return override;
}

function toRoleConfig(raw: RawRole): RoleConfig {
  const role: RoleConfig = {
    name: raw.name,
    purpose: raw.purpose,
    agents: raw.agents,
    mode: raw.mode,
    isolation: raw.isolation,
    timeout_ms: raw.timeout,
  };
  if (raw.system_prompt_file !== undefined) role.system_prompt_file = raw.system_prompt_file;
  return role;
}

function toAgentSpec(raw: RawAgent): GenericAgentSpec {
  const spec: GenericAgentSpec = { id: raw.id, bin: raw.bin, args: raw.args };
  if (raw.display_name !== undefined) spec.displayName = raw.display_name;
  if (raw.cwd_mode !== undefined) spec.cwdMode = raw.cwd_mode;
  return spec;
}

/**
 * Inverse de `toPolicyOverride` : ne rend que les champs effectivement
 * présents dans `policy`. `PolicyConfig` (complet) se passe aussi bien à
 * cette fonction que `Partial<PolicyConfig>` — un objet complet a, par
 * définition, tous ses champs "présents" — ce qui lui permet de servir aussi
 * bien à sérialiser une couche partielle (`saveLayer`, la matérialisation
 * d'une liste) qu'une configuration complète (`orch init --global`, qui
 * écrit `defaultConfig()` intégralement à la couche globale).
 */
function fromPolicyOverride(policy: Partial<PolicyConfig>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (policy.allowed !== undefined) raw.allowed = policy.allowed;
  if (policy.denied !== undefined) raw.denied = policy.denied;
  if (policy.max_parallel !== undefined) raw.max_parallel = policy.max_parallel;
  if (policy.default_isolation !== undefined) raw.default_isolation = policy.default_isolation;
  if (policy.default_mode !== undefined) raw.default_mode = policy.default_mode;
  // Stockée en millisecondes brutes plutôt que reformatée en "10m" : une
  // forme, `parseDuration` l'accepte aussi bien, et l'aller-retour
  // save/load reste ainsi exact au lieu de dépendre d'un formatage inverse.
  if (policy.default_timeout_ms !== undefined) raw.default_timeout = policy.default_timeout_ms;
  if (policy.allow_recursion !== undefined) raw.allow_recursion = policy.allow_recursion;
  if (policy.max_depth !== undefined) raw.max_depth = policy.max_depth;
  return raw;
}

function fromRoleConfig(role: RoleConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: role.name,
    purpose: role.purpose,
    agents: role.agents,
    mode: role.mode,
    isolation: role.isolation,
    timeout: role.timeout_ms,
  };
  if (role.system_prompt_file !== undefined) out.system_prompt_file = role.system_prompt_file;
  return out;
}

function fromAgentSpec(agent: GenericAgentSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: agent.id, bin: agent.bin, args: agent.args };
  if (agent.displayName !== undefined) out.display_name = agent.displayName;
  if (agent.cwdMode !== undefined) out.cwd_mode = agent.cwdMode;
  return out;
}

// ---------------------------------------------------------------------------
// Messages d'erreur — en français, nommant le fichier, le champ, et ce qui
// était attendu (voir les points de vigilance du brief de la tâche 5).
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<string, string> = {
  string: "une chaîne",
  number: "un nombre",
  int: "un entier",
  boolean: "un booléen",
  array: "une liste",
  object: "un objet",
};

function describeType(expected: string): string {
  return TYPE_NAMES[expected] ?? expected;
}

function describeReceived(input: unknown): string {
  if (input === undefined) return "aucune valeur (champ absent)";
  if (input === null) return "null";
  if (Array.isArray(input)) return `une liste (${JSON.stringify(input)})`;
  if (typeof input === "string") return `la chaîne ${JSON.stringify(input)}`;
  if (typeof input === "number") return `le nombre ${input}`;
  if (typeof input === "boolean") return `le booléen ${input}`;
  if (typeof input === "object") return `un objet (${JSON.stringify(input)})`;
  return String(input);
}

function describeIssue(issue: ZodIssue): string {
  const field = issue.path.length > 0 ? issue.path.join(".") : "(racine du fichier)";
  switch (issue.code) {
    case "unrecognized_keys": {
      const prefix = issue.path.length > 0 ? `${issue.path.join(".")}.` : "";
      const names = issue.keys.map((key) => `"${prefix}${key}"`).join(", ");
      return `${names} : champ inconnu (vérifier une faute de frappe dans le nom).`;
    }
    case "invalid_type":
      return `${field} : attendu ${describeType(issue.expected)}, reçu ${describeReceived(issue.input)}`;
    case "invalid_value":
      return `${field} : valeur non reconnue (attendu l'une de : ${issue.values.map((v) => JSON.stringify(v)).join(", ")})`;
    case "too_small":
      if (issue.origin === "string" && issue.minimum === 1) return `${field} : ne peut pas être vide`;
      if (typeof issue.minimum === "number") {
        return `${field} : doit être ${issue.inclusive ? "≥" : ">"} ${issue.minimum}`;
      }
      return `${field} : ${issue.message}`;
    case "custom":
      return `${field} : ${issue.message}`;
    default:
      return `${field} : ${issue.message}`;
  }
}

function formatZodError(error: z.ZodError, filePath: string): string {
  const lines = error.issues.map((issue) => `  - ${describeIssue(issue)}`);
  return `Configuration invalide dans ${filePath} :\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

export function globalConfigPath(): string {
  return join(homedir(), ".config", "orch", "config.toml");
}

export function projectConfigPath(root: string): string {
  return join(root, ".orch", "config.toml");
}

/** Couche locale : jamais versionnée (voir `orch init`, qui la déclare au `.gitignore`), propre à un poste de travail pour un projet donné. */
export function localConfigPath(root: string): string {
  return join(root, ".orch", "config.local.toml");
}

/** Chemin du fichier d'une couche donnée — la seule fonction qui doit choisir entre `globalConfigPath`/`projectConfigPath`/`localConfigPath`, pour que le choix de la couche reste un simple paramètre partout ailleurs (`loadLayer`, `saveLayer`, les façades CLI). */
export function configPathFor(scope: ConfigScope, root: string): string {
  switch (scope) {
    case "global":
      return globalConfigPath();
    case "project":
      return projectConfigPath(root);
    case "local":
      return localConfigPath(root);
  }
}

/** Vrai si `error` est un `ENOENT` (fichier ou répertoire absent) — partagée avec `roles.ts`, qui a le même besoin pour `system_prompt_file`. */
export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Lit un fichier de configuration. `null` si absent — ce n'est pas une erreur. Toute autre erreur nomme le fichier. */
async function readConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new Error(`Impossible de lire ${path} : ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parse et valide le contenu TOML d'un fichier de configuration en une contribution à fusionner. */
function parseConfigFile(toml: string, filePath: string): ConfigOverride {
  let raw: unknown;
  try {
    raw = parseToml(toml);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new Error(`Fichier TOML invalide : ${filePath} (ligne ${error.line}, colonne ${error.column}) — ${error.message}`);
    }
    throw error;
  }

  const result = RawFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatZodError(result.error, filePath));
  }

  // `RawFileSchema` défaute `role`/`agent` à `[]` (`z.array(...).default([])`)
  // pour que le schéma reste simple à écrire — mais ça rendrait `override`
  // infidèle au fichier : un fichier qui ne déclare aucun `[[role]]` doit
  // produire un `override.roles` absent (`undefined`), pas `[]` — c'est ce
  // que `loadLayer` promet ("exactement ce que le fichier déclare, rien de
  // plus"). D'où la vérification sur `raw` lui-même (avant l'application des
  // défauts du schéma), seule source qui distingue encore "absent du
  // fichier" de "présent mais vide" (impossible à écrire pour un array de
  // tables TOML, mais on ne présume pas de la forme de `raw` avant coup).
  const rawRecord = raw as Record<string, unknown>;
  const override: ConfigOverride = {};
  if (rawRecord["role"] !== undefined) override.roles = result.data.role.map(toRoleConfig);
  if (rawRecord["agent"] !== undefined) override.agents = result.data.agent.map(toAgentSpec);
  if (result.data.policy) {
    // `toPolicyOverride` renvoie déjà un `Partial<PolicyConfig>` ne portant
    // que les champs présents dans ce fichier — exactement la forme que
    // `ConfigOverride.policy` attend, sans conversion ni cast.
    override.policy = toPolicyOverride(result.data.policy);
  }
  return override;
}

const CONFIG_SCOPES: readonly ConfigScope[] = ["global", "project", "local"];

/** Lit et parse une couche, sans savoir si le fichier existait — partagé par `loadLayer` (qui n'a besoin que de l'override) et `loadConfig` (qui a aussi besoin de savoir si la couche a une source). */
async function readLayer(scope: ConfigScope, root: string): Promise<{ path: string; text: string | null; override: ConfigOverride }> {
  const path = configPathFor(scope, root);
  const text = await readConfigFile(path);
  const override = text !== null ? parseConfigFile(text, path) : {};
  return { path, text, override };
}

/**
 * Rend exactement ce que la couche `scope` déclare — pas le résultat d'une
 * fusion avec les autres couches, jamais des valeurs par défaut. Un fichier
 * absent rend un override vide (`{}`), pas une erreur : c'est ce qui permet
 * à une façade d'éditer une couche sans se soucier de son existence
 * préalable (voir `saveLayer`, et le brief de la tâche 13).
 */
export async function loadLayer(scope: ConfigScope, root: string): Promise<ConfigOverride> {
  return (await readLayer(scope, root)).override;
}

/**
 * Charge la configuration : `defaultConfig()` fusionnée avec le global, puis
 * le projet, puis le local, dans cet ordre — chacun s'il existe. Un fichier
 * absent des trois côtés n'est pas une erreur — la configuration par défaut
 * suffit. `config` est la fusion, seule lue par les consommateurs (moteur,
 * serveur MCP, rôles, politique) ; `layers` donne accès à la contribution
 * propre de chaque couche, pour les façades qui doivent savoir *où* vit une
 * valeur plutôt que seulement *laquelle* (provenance, écriture ciblée).
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
  const sources: { global?: string; project?: string; local?: string } = {};
  const layers: ConfigLayer[] = [];
  let config = defaultConfig();

  for (const scope of CONFIG_SCOPES) {
    const { path, text, override } = await readLayer(scope, root);
    layers.push({ scope, path, override });
    if (text !== null) {
      sources[scope] = path;
      config = mergeConfig(config, override);
    }
  }

  return { config, layers, sources, warnings: [] };
}

export type ProvenanceSource = ConfigScope | "default";

/** La dernière couche (la plus spécifique) dont `predicate(override)` est vrai, "default" si aucune. `layers` doit être dans l'ordre d'application (`loadConfig` le garantit). */
function lastLayerDeclaring(layers: readonly ConfigLayer[], predicate: (override: ConfigOverride) => boolean): ProvenanceSource {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (predicate(layer.override)) return layer.scope;
  }
  return "default";
}

/**
 * Provenance d'un champ de `policy` : la couche la plus spécifique qui le
 * déclare explicitement, "default" si aucune ne le fait. Calcul direct à
 * partir de `layers` — remplace le contournement à trois chargements
 * (`computeProvenance`, `packages/cli/src/commands/policy.ts`) que ce module
 * ne permettait pas d'éviter avant l'introduction des couches.
 */
export function policyFieldProvenance(layers: readonly ConfigLayer[], field: keyof PolicyConfig): ProvenanceSource {
  return lastLayerDeclaring(layers, (override) => override.policy?.[field] !== undefined);
}

/** Provenance d'un rôle par nom : la couche la plus spécifique qui déclare une entrée `[[role]]` de ce nom. */
export function roleProvenance(layers: readonly ConfigLayer[], name: string): ProvenanceSource {
  return lastLayerDeclaring(layers, (override) => override.roles?.some((role) => role.name === name) ?? false);
}

/** Provenance d'un agent générique par identifiant : la couche la plus spécifique qui déclare une entrée `[[agent]]` de cet id. Les agents du catalogue natif (codex, antigravity…) ne sont déclarés par aucune couche : toujours "default". */
export function agentProvenance(layers: readonly ConfigLayer[], id: string): ProvenanceSource {
  return lastLayerDeclaring(layers, (override) => override.agents?.some((agent) => agent.id === id) ?? false);
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

/** Fusionne par clé : une entrée d'`override` remplace entièrement celle de `base` qui porte la même clé ; les autres entrées de `base` sont conservées. */
function mergeByKey<T>(base: readonly T[], override: readonly T[] | undefined, keyOf: (item: T) => string): T[] {
  if (!override || override.length === 0) return [...base];
  const merged = new Map(base.map((item) => [keyOf(item), item] as const));
  for (const item of override) {
    merged.set(keyOf(item), item);
  }
  return [...merged.values()];
}

/**
 * `policy` se fusionne champ par champ (le champ d'`override`, s'il est
 * présent, remplace celui de `base`). `roles` et `agents` se fusionnent par
 * clé (`name`, `id`) : une entrée d'`override` remplace entièrement celle de
 * `base` de même clé, les entrées propres à chaque niveau sont conservées.
 */
export function mergeConfig(base: OrchConfig, override: ConfigOverride): OrchConfig {
  const policy: PolicyConfig = override.policy ? { ...base.policy, ...override.policy } : base.policy;
  const roles = mergeByKey(base.roles, override.roles, (role) => role.name);
  const agents = mergeByKey(base.agents, override.agents, (agent) => agent.id);
  return { policy, roles, agents };
}

// ---------------------------------------------------------------------------
// Configuration par défaut
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: PolicyConfig = {
  allowed: [],
  denied: [],
  max_parallel: 4,
  default_isolation: "auto",
  default_mode: "write",
  default_timeout_ms: parseDuration("10m"),
  allow_recursion: false,
  max_depth: 2,
};

/**
 * `system_prompt_file` pointe déjà ici vers la convention `roles/<name>.md`
 * (résolue par `resolveRole`, relativement à `<root>/.orch/`), alors même
 * qu'aucune couche ne l'a déclaré : c'est délibéré, depuis la tâche 13.
 *
 * `orch init` (variante projet) matérialise le *fichier* (`.orch/roles/<name>.md`,
 * un prompt système par défaut) mais ne déclare plus le rôle lui-même dans la
 * couche projet — sans quoi cette couche figerait la politique et les rôles
 * par défaut au moment de l'init, masquant toute configuration globale
 * ultérieure (exactement le défaut I11 que cette tâche corrige). En portant
 * la référence au fichier ici, dans la base commune à toutes les couches, le
 * rôle reste utilisable (prompt vide, `resolveRole` tolère un fichier
 * absent) même sans `orch init`, et se remplit dès que `orch init` a écrit
 * le fichier — quel que soit le projet, sans que la couche projet ait besoin
 * de le répéter.
 */
const DEFAULT_ROLES: RoleConfig[] = [
  {
    name: "reviewer",
    purpose: "Relit un diff et signale bugs et régressions. Ne modifie rien.",
    agents: ["codex", "antigravity"],
    mode: "read-only",
    isolation: "inplace",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/reviewer.md",
  },
  {
    name: "implementer",
    purpose: "Implémente une tâche précise et rend un diff revu.",
    agents: ["codex", "antigravity", "opencode"],
    mode: "write",
    isolation: "worktree",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/implementer.md",
  },
  {
    name: "investigator",
    purpose: "Explore le code et explique un mécanisme. Ne modifie rien.",
    agents: ["antigravity", "codex", "opencode"],
    mode: "read-only",
    isolation: "auto",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/investigator.md",
  },
];

/** La configuration de base, avant toute fusion avec un fichier global ou projet. Toujours une copie fraîche. */
export function defaultConfig(): OrchConfig {
  return {
    policy: { ...DEFAULT_POLICY, allowed: [...DEFAULT_POLICY.allowed], denied: [...DEFAULT_POLICY.denied] },
    roles: DEFAULT_ROLES.map((role) => ({ ...role, agents: [...role.agents] })),
    agents: [],
  };
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

const SAVE_HEADER =
  "# Fichier généré par @orch/core : les commentaires ajoutés à la main ne survivent pas à une prochaine écriture.\n\n";

/**
 * Régénère le fichier de la couche `scope`, à partir de `override` — pas
 * d'un `OrchConfig` fusionné. `override` ne sérialise que ce qu'il porte
 * explicitement : une section `[policy]` uniquement pour les champs présents
 * dans `override.policy`, des sections `[[role]]`/`[[agent]]` uniquement si
 * `override.roles`/`override.agents` sont définis. C'est ce qui rend une
 * couche fidèle à ce qu'elle déclare en propre, jamais un aplatissement de
 * la fusion (voir l'en-tête de ce module, et le défaut I11 qu'il corrige) :
 * un appelant qui ne veut modifier qu'un seul champ doit lire la couche au
 * préalable (`loadLayer`) et ne réécrire que le champ voulu dans l'override
 * relu, sous peine d'effacer le reste de ce qu'elle déclarait.
 *
 * Écriture atomique — fichier temporaire dans le même répertoire puis
 * `rename` — même motif que `packages/core/src/store.ts`.
 */
export async function saveLayer(scope: ConfigScope, root: string, override: ConfigOverride): Promise<void> {
  const raw: Record<string, unknown> = {};
  if (override.policy !== undefined) raw.policy = fromPolicyOverride(override.policy);
  if (override.roles !== undefined) raw.role = override.roles.map(fromRoleConfig);
  if (override.agents !== undefined) raw.agent = override.agents.map(fromAgentSpec);
  const content = SAVE_HEADER + stringifyToml(raw);

  const path = configPathFor(scope, root);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.config.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export interface PolicyListEdit {
  /** Liste effective (fusionnée) après la modification — ce que la couche `scope` porte désormais. */
  effective: string[];
  /** Vrai si la couche `scope` ne déclarait pas encore ce champ avant cette écriture. */
  materialized: boolean;
}

/**
 * Ajoute ou retire `id` de `policy.allowed`/`policy.denied`, à la couche
 * `scope` — la matérialisation de liste décrite par le brief de la tâche 13.
 *
 * `allowed`/`denied` se fusionnent par remplacement entier, pas par union
 * (voir `mergeConfig`) : une couche qui déclare `denied` remplace celui des
 * couches moins spécifiques. Se contenter d'écrire `[id]` à la couche visée
 * effacerait donc tout ce que ces couches y avaient placé. Cette fonction
 * calcule d'abord la liste **effective** (celle que `loadConfig` calculerait
 * pour ce champ), l'augmente ou l'ampute de `id`, puis écrit ce résultat —
 * jamais `id` seul — dans la couche visée, en conservant le reste de ce
 * qu'elle déclarait déjà (`loadLayer` relu avant d'écrire).
 *
 * `materialized` vaut vrai quand la couche ne déclarait pas encore ce champ :
 * elle en prend désormais la main sur toute la liste, et une couche moins
 * spécifique modifiée ensuite n'aura plus d'effet sur ce champ ici. Un
 * signal que l'appelant (CLI, TUI) doit rendre visible, pas seulement
 * consigner.
 */
export async function materializePolicyList(
  root: string,
  scope: ConfigScope,
  field: "allowed" | "denied",
  id: string,
  present: boolean,
): Promise<PolicyListEdit> {
  const { config: merged } = await loadConfig(root);
  const layer = await loadLayer(scope, root);
  const materialized = layer.policy?.[field] === undefined;

  const set = new Set(merged.policy[field]);
  if (present) set.add(id);
  else set.delete(id);
  const effective = [...set];

  await saveLayer(scope, root, { ...layer, policy: { ...layer.policy, [field]: effective } });
  return { effective, materialized };
}
