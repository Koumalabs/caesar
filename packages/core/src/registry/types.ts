import type { ReportChannel, Task } from "@orch/protocol";
import type { TaskPaths } from "@orch/protocol";
import type { OrchEventInput } from "@orch/protocol";

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
  model?: string;
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
 * `OrchEventInput` (une union discriminée sur `type`), il ne garderait que
 * les clés communes à toutes les variantes — soit uniquement `type`, en
 * perdant `text`, `tool`, `message`, etc. `DistributiveOmit` applique
 * `Omit` variante par variante pour préserver les champs propres à chacune,
 * ce qui est l'intention documentée ci-dessous.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Événement sans les champs communs, que le moteur complétera. */
export type PartialEvent = DistributiveOmit<OrchEventInput, "protocol" | "seq" | "at" | "task_id">;

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
