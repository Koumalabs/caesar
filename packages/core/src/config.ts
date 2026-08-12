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
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZodIssue } from "zod";
import { z } from "zod";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import type { Isolation, TaskMode } from "@orch/protocol";
import { TaskModeSchema } from "@orch/protocol";
import type { GenericAgentSpec } from "./registry/generic.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { NETWORK_REQUESTS } from "./network.js";
import type { NetworkRequest } from "./network.js";

export interface PolicyConfig {
  allowed: string[];
  denied: string[];
  max_parallel: number;
  default_isolation: Isolation | "auto";
  default_mode: TaskMode;
  default_network: NetworkRequest;
  default_timeout_ms: number;
  allow_recursion: boolean;
  /**
   * Autorise une tâche en écriture à s'exécuter directement dans l'arbre de
   * travail (`isolation = "inplace"`) alors qu'un worktree serait possible.
   *
   * Faux par défaut, et c'est tout l'objet du réglage : `decideInplaceWrite`
   * (`isolation.ts`) refuse cette combinaison, parce qu'elle mêle les
   * modifications du sous-agent à celles de l'utilisateur et à celles des
   * autres tâches, hors de portée d'`orch diff`. L'opt-in existe pour les
   * dépôts où l'utilisateur assume ce mélange en connaissance de cause —
   * jamais comme réponse à un worktree incomplet, dont le remède est la
   * section `[worktree]`.
   */
  allow_inplace_write: boolean;
  max_depth: number;
}

/**
 * `[worktree]` : ce qu'il faut ajouter au worktree d'une tâche isolée pour
 * qu'on puisse y travailler.
 *
 * Un worktree git ne contient que les fichiers **suivis**. Tout le reste —
 * dépendances installées, `.env`, répertoires ignorés portant des briefs ou
 * des artefacts — en est absent, si bien que l'isolation était souvent
 * littéralement inexploitable : rien ne s'y installait, rien ne s'y lançait,
 * et la contourner par `isolation = "inplace"` restait la seule issue
 * praticable. C'est la cause de fond du défaut que ce module et
 * `isolation.ts` corrigent ensemble : durcir la règle sans rendre le worktree
 * habitable n'aurait fait que déplacer le contournement.
 *
 * Hors de `[policy]` délibérément : ce n'est pas un arbitrage de gouvernance
 * — qui a le droit de quoi — mais une description du projet, au même titre
 * que la liste de ses agents. Rien ici ne s'autorise ni ne s'interdit.
 */
export interface WorktreeConfig {
  /**
   * Chemins recopiés du workspace vers le worktree, relatifs à la racine.
   * Isolés : ce que le sous-agent y écrit ne touche pas l'original. Sur un
   * système de fichiers copy-on-write (APFS, Btrfs, XFS…), rien n'est
   * réellement dupliqué tant que personne n'écrit — voir `copyTree`
   * (`engine/materialize.ts`) pour les mesures.
   */
  copy: string[];
  /**
   * Chemins **liés** plutôt que copiés — partagés, donc non isolés : deux
   * tâches simultanées écrivent dans le même répertoire, et ce qu'elles y
   * cassent, elles le cassent pour le workspace. Dernier recours, quand la
   * copie est hors de prix faute de copy-on-write ; la tâche le signale alors
   * dans son rapport plutôt que de le taire.
   */
  link: string[];
  /**
   * Commandes lancées dans le worktree après sa création et sa
   * matérialisation, avant que le sous-agent ne démarre — l'étape « Project
   * Setup » du skill `superpowers:using-git-worktrees`. Un échec fait échouer
   * la tâche : mieux vaut ne pas démarrer qu'ouvrir à l'agent un atelier à
   * moitié monté.
   */
  setup: string[];
}

export interface RoleConfig {
  name: string;
  purpose: string;
  agents: string[];
  mode: TaskMode;
  isolation: Isolation | "auto";
  network: NetworkRequest;
  timeout_ms: number;
  system_prompt_file?: string;
}

export interface OrchConfig {
  policy: PolicyConfig;
  worktree: WorktreeConfig;
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
  /**
   * `Partial<WorktreeConfig>` pour la même raison que `policy` : la fusion se
   * fait champ par champ, un fichier qui déclare `setup` sans `copy` ne dit
   * rien de `copy`. Chaque champ présent **remplace** celui de la couche
   * précédente, jamais ne s'y ajoute : une union rendrait impossible le
   * retrait local d'une entrée héritée du global, alors que c'est justement
   * le cas d'usage de la couche locale.
   */
  worktree?: Partial<WorktreeConfig>;
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
const NetworkRequestSchema = z.enum(NETWORK_REQUESTS);

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
    default_network: NetworkRequestSchema.optional(),
    default_timeout: optionalDurationMsSchema(),
    allow_recursion: z.boolean().optional(),
    allow_inplace_write: z.boolean().optional(),
    max_depth: z.number().int().nonnegative().optional(),
  })
  .strict();
type RawPolicy = z.infer<typeof RawPolicySchema>;

/**
 * Un chemin de `[worktree] copy`/`link` : relatif à la racine du workspace,
 * restant à l'intérieur, et ne touchant ni `.git` ni `.orch`.
 *
 * Validé ici plutôt qu'à la matérialisation, parce qu'une entrée invalide est
 * une erreur de configuration, pas une circonstance d'exécution : elle doit se
 * voir au chargement du fichier, avec son nom et sa ligne, et non se
 * transformer plus tard en tâche qui échoue. Les trois interdits :
 *
 * - **absolu** : désignerait un ailleurs quelconque de la machine ;
 * - **`..`** : sortirait du workspace, donc du périmètre que l'isolation
 *   promet de contenir ;
 * - **`.git` / `.orch`** : recopier ou lier l'un des deux ferait écrire le
 *   sous-agent dans l'administration du dépôt ou de l'orchestrateur —
 *   exactement ce à quoi le worktree sert à ne pas toucher.
 */
const WorktreePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), {
    message: "chemin absolu interdit : les chemins sont relatifs à la racine du workspace",
  })
  .refine((value) => !value.split(/[\\/]/).includes(".."), {
    message: 'segment ".." interdit : un chemin ne peut pas sortir du workspace',
  })
  .refine((value) => {
    const first = value.split(/[\\/]/)[0];
    return first !== ".git" && first !== ".orch";
  }, { message: '".git" et ".orch" sont exclus : ce sont l\'administration du dépôt et celle d\'orch' });

/**
 * `[worktree]` : mêmes règles que `[policy]` — chaque champ facultatif, la
 * fusion décide. Voir `WorktreeConfig`.
 */
const RawWorktreeSchema = z
  .object({
    copy: z.array(WorktreePathSchema).optional(),
    link: z.array(WorktreePathSchema).optional(),
    setup: z.array(z.string().min(1)).optional(),
  })
  .strict();
type RawWorktree = z.infer<typeof RawWorktreeSchema>;

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
    network: NetworkRequestSchema.default("auto"),
    timeout: requiredDurationMsSchema("10m"),
    system_prompt_file: z.string().optional(),
  })
  .strict();
type RawRole = z.infer<typeof RawRoleSchema>;

/**
 * `[[agent]]` : agent personnalisé, cf. `GenericAgentSpec`. Fusion par clé
 * (`id`), même logique que les rôles.
 *
 * `native_read_only` est la seule capacité déclarable ici, et c'est
 * délibéré : c'est la seule que le moteur honore sans que la construction de
 * la ligne de commande ait à coopérer (`runner.ts` s'en sert pour décider si
 * une tâche en lecture seule doit être isolée dans un worktree). Les autres —
 * schéma de sortie, injection MCP, message final en fichier, flux
 * d'événements — supposent que l'adaptateur passe quelque chose au CLI cible,
 * ce que `buildGeneric` ne fait pas : les rendre déclarables reviendrait à
 * laisser promettre un canal de rapport que rien ne branche, et à faire
 * échouer la tâche plus loin, sans rapport avec la case cochée. Le choix du
 * modèle, lui, se déduit de la présence de `{{model}}` dans les arguments
 * (voir `createGenericAgent`) plutôt que de se déclarer.
 */
const RawAgentSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1).optional(),
    bin: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd_mode: z.enum(["process", "flag"]).optional(),
    native_read_only: z.boolean().optional(),
    network_args: z.array(z.string()).optional(),
  })
  .strict();
type RawAgent = z.infer<typeof RawAgentSchema>;

const RawFileSchema = z
  .object({
    policy: RawPolicySchema.optional(),
    worktree: RawWorktreeSchema.optional(),
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
  if (raw.default_network !== undefined) override.default_network = raw.default_network;
  if (raw.default_timeout !== undefined) override.default_timeout_ms = raw.default_timeout;
  if (raw.allow_recursion !== undefined) override.allow_recursion = raw.allow_recursion;
  if (raw.allow_inplace_write !== undefined) override.allow_inplace_write = raw.allow_inplace_write;
  if (raw.max_depth !== undefined) override.max_depth = raw.max_depth;
  return override;
}

/** Même contrat que `toPolicyOverride` : seuls les champs réellement déclarés. */
function toWorktreeOverride(raw: RawWorktree): Partial<WorktreeConfig> {
  const override: Partial<WorktreeConfig> = {};
  if (raw.copy !== undefined) override.copy = raw.copy;
  if (raw.link !== undefined) override.link = raw.link;
  if (raw.setup !== undefined) override.setup = raw.setup;
  return override;
}

function fromWorktreeOverride(worktree: Partial<WorktreeConfig>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (worktree.copy !== undefined) raw.copy = worktree.copy;
  if (worktree.link !== undefined) raw.link = worktree.link;
  if (worktree.setup !== undefined) raw.setup = worktree.setup;
  return raw;
}

function toRoleConfig(raw: RawRole): RoleConfig {
  const role: RoleConfig = {
    name: raw.name,
    purpose: raw.purpose,
    agents: raw.agents,
    mode: raw.mode,
    isolation: raw.isolation,
    network: raw.network,
    timeout_ms: raw.timeout,
  };
  if (raw.system_prompt_file !== undefined) role.system_prompt_file = raw.system_prompt_file;
  return role;
}

function toAgentSpec(raw: RawAgent): GenericAgentSpec {
  const spec: GenericAgentSpec = { id: raw.id, bin: raw.bin, args: raw.args };
  if (raw.display_name !== undefined) spec.displayName = raw.display_name;
  if (raw.cwd_mode !== undefined) spec.cwdMode = raw.cwd_mode;
  if (raw.native_read_only !== undefined) spec.capabilities = { nativeReadOnly: raw.native_read_only };
  if (raw.network_args !== undefined) spec.networkArgs = raw.network_args;
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
  if (policy.default_network !== undefined) raw.default_network = policy.default_network;
  // Stockée en millisecondes brutes plutôt que reformatée en "10m" : une
  // forme, `parseDuration` l'accepte aussi bien, et l'aller-retour
  // save/load reste ainsi exact au lieu de dépendre d'un formatage inverse.
  if (policy.default_timeout_ms !== undefined) raw.default_timeout = policy.default_timeout_ms;
  if (policy.allow_recursion !== undefined) raw.allow_recursion = policy.allow_recursion;
  if (policy.allow_inplace_write !== undefined) raw.allow_inplace_write = policy.allow_inplace_write;
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
    network: role.network,
    timeout: role.timeout_ms,
  };
  if (role.system_prompt_file !== undefined) out.system_prompt_file = role.system_prompt_file;
  return out;
}

function fromAgentSpec(agent: GenericAgentSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: agent.id, bin: agent.bin, args: agent.args };
  if (agent.displayName !== undefined) out.display_name = agent.displayName;
  if (agent.cwdMode !== undefined) out.cwd_mode = agent.cwdMode;
  // Seule capacité que le TOML sait porter (voir `RawAgentSchema`) : les
  // autres, si un appelant en glissait dans le `GenericAgentSpec` qu'il
  // enregistre, ne survivraient pas à l'aller-retour. Aucune interface n'en
  // produit, et `RawAgentSchema` est `.strict()` : elles seraient de toute
  // façon refusées à la relecture.
  if (agent.capabilities?.nativeReadOnly !== undefined) out.native_read_only = agent.capabilities.nativeReadOnly;
  if (agent.networkArgs !== undefined) out.network_args = agent.networkArgs;
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

/**
 * Répertoire personnel de l'utilisateur — **le seul point d'accès au
 * répertoire personnel que ce monorepo doit utiliser** (`mcp-registration.ts`
 * en dépend aussi, pour les chemins de config MCP sous `$HOME` de `copilot`/
 * `antigravity`/`opencode` ; tout futur besoin similaire doit passer par ici,
 * jamais par un nouvel appel direct à `os.homedir()`).
 *
 * `os.homedir()` (Node) préfère déjà `$HOME` sur POSIX, mais **Bun** — le
 * runtime de `packages/tui`, voir les contraintes globales du projet —
 * ignore silencieusement `$HOME` et retombe toujours sur l'utilisateur
 * système réel, constaté en écrivant les tests de la tâche 15 : neutraliser
 * `HOME` pour isoler un test (le motif déjà en place dans
 * `packages/core/src/config.test.ts` et `packages/cli/test/support.ts`)
 * n'empêchait pas `globalConfigPath()` de résoudre le vrai
 * `~/.config/orch/` sous Bun, avec le risque réel d'écrire dedans — ce qui
 * s'est produit en écrivant le test qui a révélé le défaut. Lire `$HOME`
 * explicitement avant de retomber sur `homedir()` reproduit le comportement
 * Node existant (aucun changement sous Node, où `$HOME` l'emportait déjà) et
 * le rend fiable sous Bun aussi.
 *
 * Ce correctif n'avait d'abord routé que `globalConfigPath()` : trois appels
 * directs à `homedir()` dans `mcp-registration.ts` (`buildPlan`, chemins
 * `copilot`/`antigravity`/`opencode`) sont restés non protégés jusqu'à la
 * revue de la tâche 15, qui l'a signalé — `IntegrationsScreen.render.test.tsx`
 * neutralise `HOME` puis appelle `checkMcpStatus` pour les cinq clients au
 * montage, donc lisait les fichiers réels de la machine sous Bun malgré la
 * neutralisation. `homeDirectory` exportée plutôt que la règle recopiée à
 * l'identique dans ce second fichier.
 */
export function homeDirectory(): string {
  return process.env["HOME"] || homedir();
}

export function globalConfigPath(): string {
  return join(homeDirectory(), ".config", "orch", "config.toml");
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
  if (result.data.worktree) override.worktree = toWorktreeOverride(result.data.worktree);
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
  // Champ par champ, comme `policy` — et donc par *remplacement* de chaque
  // liste, jamais par concaténation : une union rendrait impossible le retrait
  // local d'une entrée héritée du global. Voir `ConfigOverride.worktree`.
  const worktree: WorktreeConfig = override.worktree ? { ...base.worktree, ...override.worktree } : base.worktree;
  const roles = mergeByKey(base.roles, override.roles, (role) => role.name);
  const agents = mergeByKey(base.agents, override.agents, (agent) => agent.id);
  return { policy, worktree, roles, agents };
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
  // "auto" : le réseau s'ouvre partout où l'agent retenu le permet, et le
  // rapport le dit là où il ne le permet pas. "on" en défaut ferait échouer
  // toute tâche en lecture seule sur codex — donc les rôles `reviewer` et
  // `investigator` livrés ci-dessous.
  default_network: "auto",
  default_timeout_ms: parseDuration("10m"),
  allow_recursion: false,
  // Faux : une tâche en écriture ne s'exécute pas dans l'arbre de travail de
  // l'utilisateur tant qu'un worktree est possible. Le défaut inverse est ce
  // qui a laissé trois délégations écrire sur une branche de travail réelle,
  // en silence.
  allow_inplace_write: false,
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
    network: "auto",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/reviewer.md",
  },
  {
    name: "implementer",
    purpose: "Implémente une tâche précise et rend un diff revu.",
    agents: ["codex", "antigravity", "opencode"],
    mode: "write",
    isolation: "worktree",
    network: "auto",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/implementer.md",
  },
  {
    name: "investigator",
    purpose: "Explore le code et explique un mécanisme. Ne modifie rien.",
    agents: ["antigravity", "codex", "opencode"],
    mode: "read-only",
    isolation: "auto",
    network: "auto",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/investigator.md",
  },
];

/** La configuration de base, avant toute fusion avec un fichier global ou projet. Toujours une copie fraîche. */
export function defaultConfig(): OrchConfig {
  return {
    policy: { ...DEFAULT_POLICY, allowed: [...DEFAULT_POLICY.allowed], denied: [...DEFAULT_POLICY.denied] },
    worktree: { copy: [], link: [], setup: [] },
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
 * Écriture atomique (`writeFileAtomic`, `fs-atomic.ts`) — même motif que
 * `packages/core/src/store.ts`.
 */
export async function saveLayer(scope: ConfigScope, root: string, override: ConfigOverride): Promise<void> {
  const raw: Record<string, unknown> = {};
  if (override.policy !== undefined) raw.policy = fromPolicyOverride(override.policy);
  if (override.worktree !== undefined) raw.worktree = fromWorktreeOverride(override.worktree);
  if (override.roles !== undefined) raw.role = override.roles.map(fromRoleConfig);
  if (override.agents !== undefined) raw.agent = override.agents.map(fromAgentSpec);
  const content = SAVE_HEADER + stringifyToml(raw);

  await writeFileAtomic(configPathFor(scope, root), content);
}

export interface PolicyListEdit {
  /** Liste effective (fusionnée) après la modification — ce que la couche `scope` porte désormais. */
  effective: string[];
  /** Vrai si la couche `scope` ne déclarait pas encore ce champ avant cette écriture. */
  materialized: boolean;
}

/**
 * Calcul pur de la matérialisation d'une liste — ajoute ou retire `id` de la
 * liste **effective** (`effective`, celle que `loadConfig` calculerait pour
 * ce champ), et signale si `currentOverride` (ce que la couche visée déclare
 * aujourd'hui ; `undefined` si elle ne déclare pas encore ce champ) va être
 * pris en main par cette écriture.
 *
 * Séparée de `materializePolicyList` (qui lit/écrit le disque) pour qu'une
 * façade tenant sa propre copie de travail en mémoire — le TUI
 * (`packages/tui/src/state/config-state.ts`), qui ne peut pas relire/réécrire
 * le disque à chaque frappe sans violer "aucune écriture sans action
 * explicite de l'utilisateur" — applique exactement la même règle plutôt que
 * de la recopier (voir le brief de la tâche 15, et les deux duplications de
 * règles entre façades que ce projet a déjà connues).
 */
export function materializeListEdit(
  effective: readonly string[],
  currentOverride: readonly string[] | undefined,
  id: string,
  present: boolean,
): PolicyListEdit {
  const materialized = currentOverride === undefined;
  const set = new Set(effective);
  if (present) set.add(id);
  else set.delete(id);
  return { effective: [...set], materialized };
}

/**
 * Ajoute ou retire `id` de `policy.allowed`/`policy.denied`, à la couche
 * `scope` — la matérialisation de liste décrite par le brief de la tâche 13.
 *
 * `allowed`/`denied` se fusionnent par remplacement entier, pas par union
 * (voir `mergeConfig`) : une couche qui déclare `denied` remplace celui des
 * couches moins spécifiques. Se contenter d'écrire `[id]` à la couche visée
 * effacerait donc tout ce que ces couches y avaient placé. Cette fonction
 * charge la liste effective et la déclaration actuelle de la couche visée,
 * délègue le calcul à `materializeListEdit`, puis écrit son résultat — jamais
 * `id` seul — dans la couche visée, en conservant le reste de ce qu'elle
 * déclarait déjà (`loadLayer` relu avant d'écrire).
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
  const { effective, materialized } = materializeListEdit(merged.policy[field], layer.policy?.[field], id, present);
  await saveLayer(scope, root, { ...layer, policy: { ...layer.policy, [field]: effective } });
  return { effective, materialized };
}
