import type { ReportChannel, Task } from "@caesar/protocol";
import type { TaskPaths } from "@caesar/protocol";
import type { CaesarEventInput } from "@caesar/protocol";
import type { NetworkControl } from "../network.js";

/**
 * Comment le canal MCP retour est branché côté agent, quand il l'est.
 *
 * - `"flag"` : une ou plusieurs options de ligne de commande décrivent le serveur.
 * - `"project-config"` : un fichier de configuration déposé dans le workspace.
 * - `"global-config"` : l'agent lit une configuration déjà présente sur la machine ;
 *   rien à injecter au lancement.
 * - `"none"` : l'agent ne sait pas parler MCP.
 */
export type McpInjection = "flag" | "project-config" | "global-config" | "none";

export interface AgentCapabilities {
  /** Émet un flux d'événements JSON exploitable. */
  jsonEvents: boolean;
  /** Sait contraindre nativement la forme de sa réponse finale par un JSON Schema. */
  outputSchema: boolean;
  /** Le CLI lui-même — et non le modèle — sait déposer le message final dans un fichier. */
  finalMessageFile: boolean;
  /** Dispose d'un mode lecture seule appliqué par le CLI, et non par le prompt. */
  nativeReadOnly: boolean;
  resume: boolean;
  /** Accepte des répertoires supplémentaires en écriture. */
  addDir: boolean;
  mcpInjection: McpInjection;
  model: boolean;
  /**
   * Ce que l'orchestrateur sait piloter de l'accès réseau de cet agent — et
   * non ce dont l'agent est capable. Voir `network.ts` : `"open"` signifie
   * « nous ne savons pas le refermer », pas « il a le réseau ».
   *
   * C'est la capacité dont l'absence a coûté le plus cher : `codex` tournait
   * dans un bac à sable sans réseau pendant que trois autres agents l'avaient
   * ouvert, et aucun diagnostic ne le disait.
   */
  network: NetworkControl;
}

export interface BuildContext {
  task: Task;
  paths: TaskPaths;
  /** Prompt déjà rendu par renderTaskPrompt, selon le palier retenu. */
  prompt: string;
  reportVia: ReportChannel;
  /** Chemin d'un JSON Schema déjà écrit sur disque, quand reportVia vaut "schema". */
  schemaFile?: string;
  /** Où le CLI doit déposer son message final, s'il en est capable. */
  finalMessageFile?: string;
  /**
   * Modèle demandé (`--model`/`model:`), s'il y en a un. Obligatoire — quitte
   * à passer `undefined` explicitement — plutôt qu'optionnel : voir C6 et le
   * durcissement de typage de la revue finale. Un champ optionnel est
   * précisément ce qui a permis à `runTask` d'omettre ce champ sans qu'aucune
   * erreur de compilation ne le signale, alors que les cinq adaptateurs le
   * consomment tous (`ctx.model`) : `--model` était accepté partout et
   * silencieusement ignoré. Absent → `undefined` explicite ; chaque
   * adaptateur n'ajoute son flag que si `ctx.model` est défini.
   */
  model: string | undefined;
  /** Arguments bruts ajoutés par l'utilisateur, passés en fin de ligne. */
  extraArgs: string[];
}

/** Fichier que le moteur devra écrire avant le lancement (config MCP projet, schéma…). */
export interface PreparedFile {
  path: string;
  content: string;
  /**
   * Vrai si ce fichier ne doit pas survivre à la tâche : son contenu
   * précédent (s'il en avait un) est restauré une fois l'exécution
   * terminée ; supprimé s'il n'existait pas avant. Réservé aux fichiers
   * écrits dans le workspace réel de l'utilisateur plutôt que dans le
   * répertoire de tâche que l'orchestrateur possède déjà — voir C5 de la
   * revue finale (l'adaptateur opencode, seul à écrire hors de
   * `ctx.paths.dir`) : sans ce filet, `opencode.json` était écrasé
   * silencieusement, sans sauvegarde ni restauration, y compris en
   * isolation `inplace` sur le fichier réel de l'utilisateur. Par défaut
   * (absent ou faux), comportement inchangé : le fichier reste après la
   * tâche, utile pour l'inspection a posteriori (configs MCP de
   * claude/copilot, schéma de sortie…), toutes déposées sous `paths.dir`.
   */
  restoreAfter?: boolean;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  /** Variables à ajouter à l'environnement hérité. */
  env: Record<string, string>;
  files: PreparedFile[];
  stdin?: string;
}

/**
 * `Omit` ne se distribue pas sur les types union : appliqué tel quel à
 * `CaesarEventInput` (une union discriminée sur `type`), il ne garderait que
 * les clés communes à toutes les variantes — soit uniquement `type`, en
 * perdant `text`, `tool`, `message`, etc. `DistributiveOmit` applique
 * `Omit` variante par variante pour préserver les champs propres à chacune,
 * ce qui est l'intention documentée ci-dessous.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Événement sans les champs communs, que le moteur complétera. */
export type PartialEvent = DistributiveOmit<CaesarEventInput, "protocol" | "seq" | "at" | "task_id">;

export interface Translation {
  events: PartialEvent[];
  /** Texte final de l'agent porté par cette ligne. Le dernier rencontré gagne. */
  finalText?: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  bin: string;
  capabilities: AgentCapabilities;
  /** Palier de rapport retenu, du plus fiable au plus tolérant. */
  preferredReportChannel(task: Task, channelAvailable: boolean): ReportChannel;
  build(ctx: BuildContext): SpawnPlan;
  /** Traduit une ligne de sortie vers le vocabulaire commun. Sans état. */
  translate(line: string): Translation;
}

/**
 * La règle de sélection du palier de rapport, commune à tous les adaptateurs :
 * le canal retour prime s'il est disponible et que l'agent sait s'y brancher,
 * puis le JSON Schema natif, puis en dernier recours le rapport-fichier que
 * tout agent capable d'écrire un fichier peut honorer.
 */
export function defaultPreferredReportChannel(
  capabilities: AgentCapabilities,
  channelAvailable: boolean,
): ReportChannel {
  if (channelAvailable && capabilities.mcpInjection !== "none") return "channel";
  if (capabilities.outputSchema) return "schema";
  return "file";
}
