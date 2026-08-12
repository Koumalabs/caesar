/**
 * Assets agentiques (skill Agent Skills + commandes) : la table des cibles
 * (où chaque runtime les lit), le plan d'installation et son application.
 *
 * Ce module ne connaît AUCUN contenu réel : le catalogue (la skill et les
 * commandes, au format Claude Code) lui est donné en paramètre
 * (`AgentAssetsOptions.catalog`) — c'est ce qui le rend testable sur des
 * fixtures fabriquées avant même que le générateur
 * (`scripts/generate-agent-assets.mjs`, tâche suivante, voir
 * `agent-assets.generated.ts`) n'existe. Dans `@orch/core` et non
 * `packages/cli`, même raison que `mcp-registration.ts` (voir son en-tête, et
 * `packages/cli/src/commands/mcp.ts:10-18`) : l'écran Intégrations du TUI en
 * aura besoin sans dépendre du CLI. Le câblage dans `orch init` est une tâche
 * ultérieure — aucune dépendance vers le CLI ici.
 *
 * ## La table des cibles — valeurs vérifiées empiriquement le 2026-08-12
 *
 * Confirmées sur les binaires réellement installés (listing effectif, pas la
 * documentation) : `codex debug prompt-input` (codex 0.147.0), `opencode
 * debug skill` (opencode 1.18.16), `copilot skill list`, une invocation
 * `claude` bornée (claude 2.1.228), `strings` sur le binaire `agy`
 * (antigravity). Ne PAS « corriger » ces chemins sans réévaluer contre le
 * binaire réel — plusieurs divergent de ce qu'on devinerait naïvement :
 *
 * | Cible                       | Skill (relatif à la racine)    | Commandes (relatif à la racine)             |
 * |------------------------------|----------------------------------|-----------------------------------------------|
 * | partagé (tout sauf claude)   | `.agents/skills/orch/`           | —                                              |
 * | `claude`                     | `.claude/skills/orch/` (dédié)   | `.claude/commands/` (fichiers `orch-*.md`)    |
 * | `codex`                      | partagé (`.agents/skills/orch/`) | —                                              |
 * | `copilot`                    | partagé                          | —                                              |
 * | `opencode`                   | partagé                          | `.opencode/commands/` (`orch-*.md`, pluriel)  |
 * | `antigravity`                | partagé                          | —                                              |
 *
 * Pourquoi `claude` reçoit une copie DÉDIÉE plutôt que le partagé : claude
 * 2.1.228 ne lit PAS `.agents/skills/` — une skill posée uniquement là lui
 * resterait invisible. Pourquoi `codex` ne doit PAS recevoir, en plus, une
 * copie sous `.codex/skills/orch/` : codex 0.147.0 lit déjà `.agents/skills/`
 * au niveau projet, et ne dédoublonne PAS par nom — la même skill présente
 * aux deux chemins apparaîtrait deux fois dans son listing. `copilot` de
 * même : `.github/skills/orch/` ne doit pas être livré, `copilot skill list`
 * confirme que le partagé suffit. Portée globale : mêmes chemins, composés
 * depuis `homeDirectory()` plutôt que depuis la racine du projet.
 *
 * Règle structurelle qui en découle, appliquée par construction dans
 * `ASSET_TARGETS` (un seul champ `skillDir` par cible, jamais deux) : par
 * cible, copie dédiée OU partagé, jamais les deux ; le partagé n'est produit
 * qu'une seule fois même quand plusieurs cibles le désignent — déduplication
 * par chemin résolu identique, voir `computePlan`.
 *
 * ## Fichiers gérés par orch
 *
 * Namespace : la skill vit dans un dossier `orch/` (déjà inclus dans les
 * chemins ci-dessus), les commandes sont des fichiers préfixés `orch-`. Tout
 * ce qui vit sous ce namespace, aux emplacements de la table, est réputé
 * généré par orch — donc réécrit sans ménagement quand il diffère du
 * catalogue (`update`, y compris un `orch/` ou un `orch-*.md` préexistant
 * qu'un utilisateur aurait créé lui-même : le contrat « géré par orch »
 * s'applique dès l'emplacement). Un fichier déjà identique au catalogue n'est
 * PAS réécrit (`unchanged`, comparaison après normalisation CRLF→LF,
 * écriture toujours en LF) : les runtimes surveillent ces répertoires, une
 * réécriture à l'identique déclencherait un rechargement pour rien. Un
 * artefact présent sur disque à un emplacement géré mais absent du catalogue
 * est nommé dans `stale` — jamais supprimé, la suppression restant un geste
 * explicite de l'utilisateur ou d'une commande dédiée future.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { homeDirectory } from "./config.js";
import { writeFileAtomic } from "./fs-atomic.js";
import type { McpClient } from "./mcp-registration.js";

export type AgentAssetKind = "skill" | "command";

/** Un fichier source du catalogue. `path` est relatif à l'artefact (ex. "SKILL.md", "references/cli.md"), toujours en séparateurs POSIX. */
export interface AgentAsset {
  kind: AgentAssetKind;
  id: string;
  path: string;
  content: string;
}

export type AssetScope = "project" | "global";

// ---------------------------------------------------------------------------
// Rendu des commandes — une fonction par format cible
// ---------------------------------------------------------------------------

function toLf(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/** Claude Code est le format source des commandes : rendu identité (normalisé en LF, cf. l'en-tête). */
export function renderClaudeCommand(asset: AgentAsset): string {
  return toLf(asset.content);
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;

/** Champs que la doc de commandes d'OpenCode reconnaît (confirmé sur 1.18.16) — tout le reste du frontmatter Claude Code (`allowed-tools`, `argument-hint`, …) lui est étranger et doit être retiré. */
const OPENCODE_FRONTMATTER_KEYS = new Set(["description", "agent", "model"]);

/**
 * Adapte une commande source (frontmatter Claude Code) au format OpenCode :
 * conserve `description` (et `agent`/`model` si présents), retire le reste du
 * frontmatter, laisse le corps intact.
 *
 * Filtrage ligne à ligne plutôt qu'un vrai parseur YAML : les trois champs du
 * format source (`description`, `allowed-tools`, `argument-hint`, voir
 * `agent-assets.generated.ts`) sont chacun un scalaire sur une seule ligne,
 * et ce filtrage suffit sans faire dépendre `@orch/core` d'une librairie YAML
 * pour ça seul.
 */
export function renderOpencodeCommand(asset: AgentAsset): string {
  const content = toLf(asset.content);
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) return content; // pas de frontmatter : rien à adapter

  const full = match[0]!;
  const block = match[1] ?? "";
  const body = content.slice(full.length);
  const kept = block.split("\n").filter((line) => {
    const key = /^([A-Za-z0-9_-]+):/.exec(line)?.[1];
    return key === undefined || OPENCODE_FRONTMATTER_KEYS.has(key);
  });
  return `---\n${kept.join("\n")}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// La table des cibles
// ---------------------------------------------------------------------------

/** Un client de `MCP_CLIENTS`, tel qu'il lit la skill et les commandes d'orch. Voir la table de faits en en-tête. */
export interface AssetTarget {
  client: McpClient;
  /** Répertoire (relatif à la racine, ou à HOME en portée globale) où ce client lit la skill "orch" — dédié ou partagé selon la cible, jamais les deux. */
  skillDir: string;
  /** Répertoire des commandes de ce client (fichiers `orch-*.md`) ; absent si cette cible ne lit aucune commande. */
  commandsDir?: string;
  /** Rendu appliqué au contenu source (format Claude Code) pour produire chaque commande de cette cible. Ignoré si `commandsDir` est absent. */
  renderCommand?: (asset: AgentAsset) => string;
}

/** Emplacement partagé : identique en valeur pour toute cible qui n'a pas de copie dédiée, ce qui suffit à en faire une seule production (déduplication par chemin résolu, `computePlan`). */
const SHARED_SKILL_DIR = ".agents/skills/orch";

/** Le seul endroit où vit la connaissance des chemins par runtime. */
export const ASSET_TARGETS: readonly AssetTarget[] = [
  {
    client: "claude",
    // Dédié — requis : claude 2.1.228 ne lit pas .agents/skills/ (voir l'en-tête).
    skillDir: ".claude/skills/orch",
    commandsDir: ".claude/commands",
    renderCommand: renderClaudeCommand,
  },
  // codex lit .agents/skills/ au niveau projet et ne dédoublonne pas par nom :
  // pas de copie sous .codex/skills/orch/ en plus (voir l'en-tête).
  { client: "codex", skillDir: SHARED_SKILL_DIR },
  // copilot skill list confirme que le partagé suffit : pas de .github/skills/orch/.
  { client: "copilot", skillDir: SHARED_SKILL_DIR },
  { client: "opencode", skillDir: SHARED_SKILL_DIR, commandsDir: ".opencode/commands", renderCommand: renderOpencodeCommand },
  { client: "antigravity", skillDir: SHARED_SKILL_DIR },
];

function targetFor(client: McpClient): AssetTarget {
  const target = ASSET_TARGETS.find((t) => t.client === client);
  if (!target) throw new Error(`Cible inconnue dans la table des assets agentiques : "${client}".`);
  return target;
}

// ---------------------------------------------------------------------------
// Résultat
// ---------------------------------------------------------------------------

export type AgentAssetAction = "create" | "update" | "unchanged";

export interface AgentAssetFile {
  kind: AgentAssetKind;
  id: string;
  /** Chemin absolu sur disque. */
  path: string;
  action: AgentAssetAction;
}

/** Un artefact `orch`/`orch-*` présent sur disque à un emplacement géré mais absent du catalogue — nommé, jamais supprimé. */
export interface AgentAssetStale {
  kind: AgentAssetKind;
  id: string;
  path: string;
}

export type SettingsMergeAction = "create" | "update" | "unchanged" | "skip";

export interface AgentAssetSettingsMerge {
  /** Toujours `<root>/.claude/settings.json` — jamais posé en portée globale. */
  path: string;
  action: SettingsMergeAction;
  /** Tools ajoutés à `permissions.allow` lors de cette passe ; vide si "unchanged" ou "skip". */
  added: string[];
}

export interface AgentAssetInstall {
  files: AgentAssetFile[];
  stale: AgentAssetStale[];
  /** Présent seulement en portée projet quand `claude` fait partie des cibles retenues — voir `computeSettingsMerge`. */
  settings?: AgentAssetSettingsMerge;
  /** Avertissements non bloquants (aujourd'hui : JSON invalide dans settings.json). */
  warnings: string[];
}

export interface AgentAssetsOptions {
  root: string;
  scope: AssetScope;
  /** Les cibles retenues, par id de `MCP_CLIENTS`. */
  clients: readonly McpClient[];
  /** Le catalogue d'assets — généré (`AGENT_ASSETS`, `agent-assets.generated.ts`) ou fabriqué pour un test. */
  catalog: readonly AgentAsset[];
}

// ---------------------------------------------------------------------------
// Validation des chemins — avant tout `join`
// ---------------------------------------------------------------------------

/**
 * Rejette un chemin d'asset qui sortirait de son artefact : absolu,
 * antislash, segment `..`, ou segment vide.
 *
 * Le contrat d'`AgentAsset.path` promet des séparateurs POSIX uniquement
 * (voir sa doc) — un antislash n'y est donc jamais un caractère de nom de
 * fichier légitime. Rejeté explicitement plutôt que découpé comme un
 * séparateur ou ignoré comme un caractère opaque : un découpage sur `/`
 * seul laissait passer `"..\\..\\..\\..\\evil.md"` (aucun `/`, donc traité
 * comme un unique segment sans `..`), qui échappe pourtant bel et bien à la
 * racine une fois recombiné par `path.join` sous Windows — défaut trouvé en
 * revue de cette tâche, voir `agent-assets.test.ts`.
 */
function assertSafeAssetPath(path: string): void {
  if (path.startsWith("/")) {
    throw new Error(`Chemin d'asset invalide : "${path}" est absolu (attendu relatif à l'artefact).`);
  }
  if (path.includes("\\")) {
    throw new Error(`Chemin d'asset invalide : "${path}" contient un antislash — seuls les séparateurs POSIX ("/") sont acceptés.`);
  }
  for (const segment of path.split("/")) {
    if (segment === "") throw new Error(`Chemin d'asset invalide : "${path}" contient un segment vide.`);
    if (segment === "..") throw new Error(`Chemin d'asset invalide : "${path}" contient ".." — un asset ne peut pas sortir de son artefact.`);
  }
}

/**
 * Défense en profondeur : `skillDir`/`commandsDir` sont des constantes de la
 * table, et `asset.path` est déjà validé (`assertSafeAssetPath`) — cette
 * destination ne peut mathématiquement pas sortir de `base`, mais une erreur
 * claire vaut mieux qu'un write silencieux ailleurs si l'invariant se
 * rompait un jour.
 *
 * Agnostique au séparateur (découpage sur `/[\\/]/`, jamais sur `"../"` en
 * dur) : sous Windows, `path.relative` rend ses résultats avec des
 * antislashes, et un test codé sur le seul séparateur POSIX laissait passer
 * cette même défense inopérante — trouvé dans la même revue que le défaut
 * ci-dessus.
 */
function assertWithinBase(path: string, base: string): void {
  const rel = relative(base, path);
  const segments = rel.split(/[\\/]/);
  if (isAbsolute(rel) || segments.includes("..")) {
    throw new Error(`Chemin résolu hors de la racine visée : "${path}" (racine : "${base}").`);
  }
}

function resolveBase(opts: AgentAssetsOptions): string {
  return opts.scope === "project" ? opts.root : homeDirectory();
}

// ---------------------------------------------------------------------------
// Diff fichier par fichier
// ---------------------------------------------------------------------------

interface PlannedFile extends AgentAssetFile {
  content: string;
}

/** "create" si absent, "unchanged" si le disque (normalisé CRLF→LF) porte déjà exactement `content`, "update" sinon. Une lecture, jamais une écriture — c'est ce qui rend `planAgentAssets` pur au sens de ce module (n'écrit rien). */
function actionFor(path: string, content: string): AgentAssetAction {
  if (!existsSync(path)) return "create";
  const onDisk = toLf(readFileSync(path, "utf8"));
  return onDisk === content ? "unchanged" : "update";
}

function buildFileRecord(kind: AgentAssetKind, id: string, path: string, content: string): PlannedFile {
  return { kind, id, path, action: actionFor(path, content), content };
}

/** Orphelins sous un répertoire de skill géré : tout fichier présent qui n'est pas dans le catalogue actuel. */
function scanStaleSkill(skillDir: string, plannedRelPaths: ReadonlySet<string>): AgentAssetStale[] {
  if (!existsSync(skillDir)) return [];
  const id = basename(skillDir);
  const stale: AgentAssetStale[] = [];
  const walk = (current: string, relPrefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (!plannedRelPaths.has(rel)) stale.push({ kind: "skill", id, path: abs });
    }
  };
  walk(skillDir, "");
  return stale;
}

const COMMAND_PREFIX = "orch-";

/** Orphelins sous un répertoire de commandes géré : tout fichier `orch-*.md` qui n'est plus dans le catalogue. Les commandes d'autres origines (sans le préfixe) ne sont ni scannées ni rapportées. */
function scanStaleCommands(commandsDir: string, plannedNames: ReadonlySet<string>): AgentAssetStale[] {
  if (!existsSync(commandsDir)) return [];
  const stale: AgentAssetStale[] = [];
  for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(COMMAND_PREFIX) || !entry.name.endsWith(".md")) continue;
    if (plannedNames.has(entry.name)) continue;
    stale.push({ kind: "command", id: entry.name.slice(COMMAND_PREFIX.length, -".md".length), path: join(commandsDir, entry.name) });
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Fusion de <root>/.claude/settings.json
// ---------------------------------------------------------------------------

/** Les six tools MCP qui ne modifient aucun fichier de l'utilisateur — seuls candidats à un ajout automatique dans `permissions.allow` (lecture seule : lister agents/rôles, statut, attendre, logs, diff). */
const SETTINGS_MANAGED_TOOLS: readonly string[] = [
  "mcp__orch__orch_list_agents",
  "mcp__orch__orch_list_roles",
  "mcp__orch__orch_status",
  "mcp__orch__orch_await",
  "mcp__orch__orch_logs",
  "mcp__orch__orch_diff",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PlannedSettings extends AgentAssetSettingsMerge {
  /** Présent seulement quand `action` est "create" ou "update" — c'est ce que `installAgentAssets` écrit. */
  content?: string;
}

/**
 * `permissions.allow` reçoit `SETTINGS_MANAGED_TOOLS`, append-si-absent :
 * dédoublonnage par appartenance (jamais un doublon d'un tool déjà accordé),
 * tout le reste du fichier préservé (clés inconnues comprises, y compris les
 * autres entrées de `permissions`), jamais de retrait d'une entrée
 * existante. `applyPlan` (`mcp-registration.ts`) n'est pas réutilisable ici :
 * il remplace un objet dont il est seul propriétaire (`mcpServers.orch`),
 * quand `permissions.allow` appartient à l'utilisateur et ne doit être
 * qu'augmenté.
 *
 * JSON invalide, racine non-objet, ou forme anormale de `permissions`/
 * `permissions.allow` (présent mais pas un objet / pas une liste — `null`
 * compris) ⇒ `action: "skip"` et un avertissement, jamais d'écriture. Ce
 * dernier cas est délibérément traité comme le JSON invalide plutôt que
 * silencieusement retombé sur `{}`/`[]` : un `"permissions": null` ou
 * `"allow": "tout"` posé à la main par l'utilisateur est une valeur qu'il a
 * choisie, pas une absence — l'écraser sans le dire aurait perdu cette
 * intention sans qu'aucun signal n'apparaisse dans `warnings` (défaut trouvé
 * en revue de cette tâche, voir `agent-assets.test.ts`). N'agit qu'en portée
 * projet, et seulement si `claude` fait partie des cibles retenues ;
 * `~/.claude/settings.json` n'est jamais touché (portée globale hors de
 * propos pour ce fichier).
 */
function computeSettingsMerge(
  opts: AgentAssetsOptions,
  clients: readonly McpClient[],
): { settings?: PlannedSettings; warning?: string } {
  if (opts.scope !== "project" || !clients.includes("claude")) return {};

  const path = join(opts.root, ".claude", "settings.json");
  if (!existsSync(path)) {
    const allow = [...SETTINGS_MANAGED_TOOLS];
    const content = JSON.stringify({ permissions: { allow } }, null, 2) + "\n";
    return { settings: { path, action: "create", added: allow, content } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      settings: { path, action: "skip", added: [] },
      warning: `JSON invalide dans ${path} (${error instanceof Error ? error.message : String(error)}) — permissions.allow non modifié.`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      settings: { path, action: "skip", added: [] },
      warning: `${path} ne contient pas un objet JSON — permissions.allow non modifié.`,
    };
  }

  const permissionsValue = parsed["permissions"];
  if (permissionsValue !== undefined && !isRecord(permissionsValue)) {
    return {
      settings: { path, action: "skip", added: [] },
      warning: `${path} : "permissions" n'est pas un objet (${JSON.stringify(permissionsValue)}) — permissions.allow non modifié.`,
    };
  }
  const permissions = permissionsValue ?? {};

  const allowValue = permissions["allow"];
  if (allowValue !== undefined && !Array.isArray(allowValue)) {
    return {
      settings: { path, action: "skip", added: [] },
      warning: `${path} : "permissions.allow" n'est pas une liste (${JSON.stringify(allowValue)}) — permissions.allow non modifié.`,
    };
  }
  const allow: unknown[] = allowValue ?? [];

  const missing = SETTINGS_MANAGED_TOOLS.filter((tool) => !allow.includes(tool));

  if (missing.length === 0) {
    return { settings: { path, action: "unchanged", added: [] } };
  }

  const merged = { ...parsed, permissions: { ...permissions, allow: [...allow, ...missing] } };
  const content = JSON.stringify(merged, null, 2) + "\n";
  return { settings: { path, action: "update", added: missing, content } };
}

// ---------------------------------------------------------------------------
// Plan et installation
// ---------------------------------------------------------------------------

interface Plan {
  files: PlannedFile[];
  stale: AgentAssetStale[];
  settings?: PlannedSettings;
  warnings: string[];
}

/**
 * Calcule le plan complet — lectures seules (fichiers destination, répertoires
 * gérés, `settings.json`), jamais une écriture. Partagé par `planAgentAssets`
 * (qui rend `computePlan` tel quel, `content` en moins) et
 * `installAgentAssets` (qui l'utilise pour savoir quoi écrire) : une seule
 * logique de diff, jamais deux à tenir synchronisées.
 */
function computePlan(opts: AgentAssetsOptions): Plan {
  for (const asset of opts.catalog) assertSafeAssetPath(asset.path);

  const clients = [...new Set(opts.clients)];
  const targets = clients.map(targetFor);
  const base = resolveBase(opts);

  const skillAssets = opts.catalog.filter((asset) => asset.kind === "skill");
  const commandAssets = opts.catalog.filter((asset) => asset.kind === "command");

  const files: PlannedFile[] = [];
  const stale: AgentAssetStale[] = [];

  // Le partagé n'est produit qu'une fois : plusieurs cibles résolvent au même
  // chemin (SHARED_SKILL_DIR), et un Set les fusionne naturellement.
  const skillDirs = new Set(targets.map((target) => join(base, target.skillDir)));
  const plannedSkillRelPaths = new Set(skillAssets.map((asset) => asset.path));
  for (const dir of skillDirs) {
    for (const asset of skillAssets) {
      const dest = join(dir, asset.path);
      assertWithinBase(dest, base);
      files.push(buildFileRecord(asset.kind, asset.id, dest, toLf(asset.content)));
    }
    stale.push(...scanStaleSkill(dir, plannedSkillRelPaths));
  }

  // Les commandes, à l'inverse, ne sont jamais partagées : chaque cible qui
  // en lit a son propre répertoire et son propre rendu.
  const plannedCommandNames = new Set(commandAssets.map((asset) => `${COMMAND_PREFIX}${asset.path}`));
  for (const target of targets) {
    if (!target.commandsDir || !target.renderCommand) continue;
    const dir = join(base, target.commandsDir);
    for (const asset of commandAssets) {
      const dest = join(dir, `${COMMAND_PREFIX}${asset.path}`);
      assertWithinBase(dest, base);
      files.push(buildFileRecord(asset.kind, asset.id, dest, target.renderCommand(asset)));
    }
    stale.push(...scanStaleCommands(dir, plannedCommandNames));
  }

  const { settings, warning } = computeSettingsMerge(opts, clients);

  return { files, stale, settings, warnings: warning ? [warning] : [] };
}

function toPublicResult(plan: Plan): AgentAssetInstall {
  const result: AgentAssetInstall = {
    files: plan.files.map(({ content: _content, ...rest }) => rest),
    stale: plan.stale,
    warnings: plan.warnings,
  };
  if (plan.settings) {
    const { content: _content, ...rest } = plan.settings;
    result.settings = rest;
  }
  return result;
}

/** Pur : construit le plan sans jamais écrire sur disque (voir `computePlan`, `actionFor`). */
export function planAgentAssets(opts: AgentAssetsOptions): AgentAssetInstall {
  return toPublicResult(computePlan(opts));
}

/**
 * Applique le plan : `writeFileAtomic` (`fs-atomic.ts`) pour chaque fichier
 * dont l'action n'est pas "unchanged", puis `settings.json` si `action` vaut
 * "create" ou "update". Le résultat rendu est celui du plan qui a servi à
 * écrire — les actions qu'il décrit sont déjà exactement ce qui vient d'être
 * fait, pas besoin de relire le disque après coup.
 */
export async function installAgentAssets(opts: AgentAssetsOptions): Promise<AgentAssetInstall> {
  const plan = computePlan(opts);

  for (const file of plan.files) {
    if (file.action === "unchanged") continue;
    await writeFileAtomic(file.path, file.content);
  }
  if (plan.settings?.content !== undefined) {
    await writeFileAtomic(plan.settings.path, plan.settings.content);
  }

  return toPublicResult(plan);
}
