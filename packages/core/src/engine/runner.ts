/**
 * Assemblage d'une exécution complète : résout l'agent, prépare l'isolation,
 * choisit le palier de rapport, lance le processus, recoupe le rapport avec
 * git, et met à jour le store. C'est la pièce qui transforme le registre en
 * orchestrateur.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Channel, Finding, Isolation, CaesarEvent, Report, ReportChannel, Task, TaskMode, TaskPaths } from "@caesar/protocol";
import {
  REPORT_PROTOCOL,
  ReportSchema,
  TASK_PROTOCOL,
  TaskSchema,
  renderTaskPrompt,
  strictReportJsonSchema,
  taskEnv,
  taskPaths,
  writeReport,
  writeTask,
} from "@caesar/protocol";
import type { WorktreeConfig } from "../config.js";
import { decideInplaceWrite } from "../isolation.js";
import { resolveAgentDefinition } from "../registry/index.js";
import { detectUntrackedNeeds, materializeUntracked, runSetup } from "./materialize.js";
import type { MaterializeResult } from "./materialize.js";
import type { AgentDefinition, SpawnPlan } from "../registry/types.js";
import type { GenericAgentSpec } from "../registry/generic.js";
import type { ChangesVerifiedBy, ReportSource, TaskRecord, TaskStatus, TaskStore } from "../store.js";
import { resolveReport, reconcileChanges } from "./report.js";
import { runAgentProcess } from "./spawn.js";
import type { RunResult } from "./spawn.js";
import {
  captureWorkspaceStatus,
  createWorktree,
  diffWorkspaceStatus,
  diffWorktree,
  hasCommits,
  repoRoot,
  worktreesDirIgnored,
} from "./worktree.js";
import type { Queue } from "./queue.js";
import type { WorktreeDiff, WorktreeHandle } from "./worktree.js";
import { clearWorktreeInUse, markWorktreeInUse } from "./gc.js";
import { acquireLease, releaseLease } from "./lock.js";

const DEFAULT_TIMEOUT_MS = 600_000;

/** Nom sous lequel le canal retour est déclaré côté agent (voir `Channel.server_name`). Exporté : un lanceur alternatif (voir `ChannelLauncher`) doit pouvoir le reprendre sans le redéfinir. */
export const CHANNEL_SERVER_NAME = "caesar";

/**
 * Chemin absolu de `dist/bin.js` dans `@caesar/mcp-channel`, résolu via la
 * résolution de module Node plutôt que supposé à un chemin relatif fixe —
 * voir le brief de la tâche 9 ("résous son chemin dynamiquement plutôt que
 * de le supposer"). Cette résolution survit à une installation en dehors de
 * ce dépôt (npm, un lien global…), tant que `@caesar/mcp-channel` reste une
 * dépendance déclarée de `@caesar/core` (voir son `package.json`) : c'est la
 * même méthode que `resolveTuiEntry` dans
 * `packages/cli/src/commands/config.ts` pour `@caesar/tui`.
 *
 * `@caesar/mcp-channel` restreint son `"exports"` à `"."` (contrairement à
 * `@caesar/tui`, dépourvu d'`"exports"`, que `resolveTuiEntry` peut donc
 * résoudre jusqu'à `package.json` directement) : demander la résolution de
 * `"@caesar/mcp-channel/package.json"` échouerait (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
 * On résout donc l'entrée principale (`"."` → `dist/index.js`) et on
 * descend vers son voisin `dist/bin.js`, toujours émis dans le même
 * répertoire par `tsc` puisque `src/index.ts` et `src/bin.ts` sont tous deux
 * à la racine de `src/`, sans sous-répertoire.
 *
 * N'a de sens que sous Node : un binaire compilé (tâche 12) n'a plus de
 * `node_modules` où chercher quoi que ce soit — c'est précisément pourquoi
 * cette résolution n'est plus appelée en dur par `buildChannel`, seulement
 * depuis `defaultChannelLauncher`, le lanceur par défaut (comportement
 * historique, inchangé).
 */
function resolveChannelEntry(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@caesar/mcp-channel");
  return join(dirname(indexPath), "bin.js");
}

/**
 * Construit les coordonnées du canal retour pour une tâche : un lanceur, `taskDir`
 * en entrée, un `Channel | undefined` en sortie (jamais d'erreur).
 *
 * Point d'extension de la tâche 12 : dans un binaire compilé (`bun build
 * --compile`), plus aucune résolution de module n'a de sens
 * (`resolveChannelEntry` échoue, il n'y a plus de `node_modules`) — le
 * binaire ne peut plus *déduire* comment lancer le canal, il doit se le
 * faire dire. `configureChannelLauncher`, appelée une fois par le point
 * d'entrée (voir `packages/cli/src/bun-entry.ts`), est ce point de
 * configuration — une fonction plutôt qu'une variable d'environnement :
 * testable directement (un test appelle `configureChannelLauncher` avec un
 * lanceur factice et observe `task.channel`), sans dépendre d'un état
 * ambiant que `vitest` devrait manipuler et restaurer à chaque test.
 */
export type ChannelLauncher = (taskDir: string) => Channel | undefined;

/**
 * Lanceur par défaut, jamais reconfiguré par le chemin Node (`bin.ts`) :
 * c'est le comportement historique de `buildChannel`, avant la tâche 12,
 * repris tel quel — `command` est le binaire Node lui-même
 * (`process.execPath`), jamais `caesar-channel` par son nom ni le fichier
 * résolu directement : ni l'un ni l'autre ne peuvent être supposés
 * exécutables ou présents dans le `PATH` du sous-agent qui le lancera — voir
 * le brief de la tâche 9. Lève si `resolveChannelEntry` échoue ;
 * `buildChannel`, son seul appelant, absorbe cette exception.
 */
export function defaultChannelLauncher(taskDir: string): Channel | undefined {
  const entry = resolveChannelEntry();
  return { transport: "mcp-stdio", command: process.execPath, args: [entry, taskDir], server_name: CHANNEL_SERVER_NAME };
}

let channelLauncher: ChannelLauncher = defaultChannelLauncher;

/**
 * Point d'entrée de l'extension de la tâche 12 : remplace le lanceur du
 * canal retour utilisé par tout `runTask` ultérieur. Le point d'entrée Bun
 * (`bun-entry.ts`) l'appelle une fois au démarrage avec un lanceur qui
 * auto-invoque le binaire compilé (`caesar channel serve --task-dir <dir>`) ;
 * le point d'entrée Node (`bin.ts`) ne l'appelle jamais, laissant
 * `defaultChannelLauncher` en place — comportement inchangé.
 */
export function configureChannelLauncher(launcher: ChannelLauncher): void {
  channelLauncher = launcher;
}

/**
 * Ne lève jamais, quel que soit le lanceur configuré : une résolution en
 * échec (installation cassée, paquet introuvable, lanceur personnalisé qui
 * lève…) rend `undefined` plutôt que de faire échouer toute la tâche — le
 * canal n'est jamais un point de défaillance, dans aucun des deux mondes.
 */
function buildChannel(taskDir: string): Channel | undefined {
  try {
    return channelLauncher(taskDir);
  } catch {
    return undefined;
  }
}

/**
 * Nom du fichier où un CLI capable de `finalMessageFile` dépose son dernier
 * message, sous le répertoire de la tâche. Chemin fixe et prévisible : un
 * agent qui connaît son répertoire de tâche (`$CAESAR_TASK_DIR`) peut le
 * retrouver sans qu'aucun jeton dédié n'existe dans le gabarit générique
 * d'arguments (`GenericAgentSpec`, tâche 3) — c'est ce que fait l'agent
 * factice dans les tests.
 */
const FINAL_MESSAGE_FILE_NAME = "final-message.txt";

export interface RunnerDeps {
  store: TaskStore;
  root: string;
  /**
   * Sémaphore partageant le plafond `policy.max_parallel` entre tous les
   * `runTask` d'une même façade. Obligatoire — quitte à passer `undefined`
   * explicitement — voir C4/le durcissement de typage de la revue finale :
   * une propriété optionnelle est précisément ce qui a laissé les trois
   * façades (`caesar run`, `caesar_delegate`, `caesar agents test`) omettre le
   * câblage sans qu'aucune erreur de compilation ne le signale, rendant
   * `max_parallel` inappliqué de bout en bout. `undefined` reste un choix
   * légitime pour un appelant qui ne veut délibérément aucune limite (voir
   * les tests) ; ce n'est plus un oubli silencieux.
   */
  queue: Queue | undefined;
}

export interface RunTaskInput {
  agentId: string;
  objective: string;
  context?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
  mode: TaskMode;
  isolation?: Isolation | "auto";
  /**
   * Autorise une tâche en écriture à s'exécuter en isolation `"inplace"` dans
   * un dépôt git utilisable — ce que `decideInplaceWrite` (`isolation.ts`)
   * refuse sinon.
   *
   * Une permission **portée par l'appelant**, jamais lue depuis la
   * configuration par le moteur, sur le modèle d'`extraAgents` : `runTask` n'a
   * que `deps.root`, et un moteur qui irait chercher lui-même l'opt-in
   * transformerait chaque appel direct en angle mort. Absente (le défaut), la
   * réponse est non : un appelant qui oublie de transmettre
   * `policy.allow_inplace_write` obtient un refus, jamais un contournement
   * silencieux. C'est le sens même de la correction — voir l'en-tête
   * d'`isolation.ts`.
   */
  allowInplaceWrite?: boolean;
  /**
   * Le réseau est-il disponible pour cette tâche ? Déjà résolu — la demande
   * tri-état s'arrête chez `resolveDelegation`, qui l'a confrontée à ce que
   * l'agent permet. Absent : vrai, comme le défaut du protocole, pour que les
   * appelants qui n'en savent rien (`caesar agents test`) restent inchangés.
   */
  network?: boolean;
  /** Avertissement issu de cette résolution, à verser au rapport (voir `ResolvedDelegation.networkWarning`). */
  networkWarning?: string;
  workspace: string;
  role?: string;
  model?: string;
  timeoutMs?: number;
  depth?: number;
  /**
   * Agents génériques déclarés en configuration (`CaesarConfig.agents`,
   * `[[agent]]` du TOML), consultés en plus du catalogue natif pour résoudre
   * `agentId` — voir `resolveAgentDefinition` et C1 de la revue finale.
   * Absent ou vide : catalogue natif seul (comportement inchangé). Les
   * appelants qui disposent déjà de la configuration (`caesar run`,
   * `caesar_delegate`, `caesar agents test`) la transmettent ici plutôt que de la
   * faire recharger par `runTask`, qui n'a autrement que `deps.root`.
   */
  extraAgents?: GenericAgentSpec[];
  /**
   * La section `[worktree]` du projet (`CaesarConfig.worktree`) : ce qu'il faut
   * ajouter au worktree pour qu'on puisse y travailler, et ce qu'il faut y
   * lancer avant l'agent.
   *
   * Transmise par l'appelant plutôt que rechargée ici, comme `extraAgents` et
   * pour la même raison : `runTask` n'a que `deps.root`, et les façades
   * disposent déjà de la configuration fusionnée. Absente : le worktree reste
   * ce que git en fait — les fichiers suivis, rien de plus. Sans effet en
   * isolation `"inplace"`, où le workspace réel est déjà complet.
   */
  worktreeSetup?: WorktreeConfig;
  extraArgs?: string[];
  /**
   * Active le canal retour MCP bidirectionnel pour cette tâche, si l'agent
   * cible sait charger un serveur MCP (`capabilities.mcpInjection !==
   * "none"`) : le runner construit alors lui-même les coordonnées du
   * `Channel` (voir `buildChannel`/`resolveChannelEntry` plus bas) — binaire
   * `caesar-channel` résolu dynamiquement, argument `taskDir`, nom de serveur
   * `"caesar"` — aucun appelant n'a besoin d'en connaître le détail. Absent ou
   * faux (défaut) : comportement inchangé, aucun canal proposé — voir le
   * brief de la tâche 9 : le canal ajoute un processus et une injection de
   * configuration à chaque délégation, cela se choisit explicitement.
   *
   * Sans effet, jamais une erreur, si l'agent ne sait pas charger de serveur
   * MCP ou si la résolution du binaire échoue (installation cassée…) : le
   * canal n'est jamais un point de défaillance, la tâche retombe alors sur
   * le palier de rapport suivant (`defaultPreferredReportChannel`).
   */
  channel?: boolean;
  /**
   * Identifiant à utiliser pour cette tâche, plutôt que d'en générer un.
   * Permet à l'appelant de connaître à l'avance le répertoire de la tâche
   * (`<root>/.caesar/tasks/<taskId>`) — donc de la suivre (`events.jsonl`)
   * pendant qu'elle tourne, ou de la référencer avant même que `runTask` ne
   * résolve. Absent : comportement inchangé, un identifiant est généré ici
   * comme avant. Sert notamment le CLI (`caesar run`, avancement en direct) et,
   * à terme, le serveur MCP (`caesar_delegate`, qui doit rendre un identifiant
   * immédiatement pour permettre plusieurs délégations en parallèle).
   */
  taskId?: string;
  /**
   * Transmis tel quel à `runAgentProcess`, qui le supporte déjà : permet à
   * l'appelant d'annuler une tâche en cours sans attendre sa résolution, en
   * garantissant qu'aucun sous-processus n'est laissé derrière (SIGTERM puis,
   * à défaut de réponse, SIGKILL — voir `spawn.ts`).
   */
  signal?: AbortSignal;
  /**
   * Transmis tel quel à `runAgentProcess`, qui le supporte déjà : permet à
   * l'appelant d'observer les événements normalisés au fil de l'eau, plutôt
   * que de devoir relire `events.jsonl` après coup.
   */
  onEvent?: (event: CaesarEvent) => void;
}

export interface TaskOutcome {
  record: TaskRecord;
  report: Report;
  source: ReportSource;
  diff?: WorktreeDiff;
}

export async function runTask(deps: RunnerDeps, input: RunTaskInput): Promise<TaskOutcome> {
  const agentDef = resolveAgentDefinition(input.agentId, input.extraAgents ?? []);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const depth = input.depth ?? 0;

  const id = input.taskId ?? generateTaskId();
  const taskDir = join(deps.root, ".caesar", "tasks", id);
  const paths = taskPaths(taskDir);

  // Vérifié ici, avant d'engager l'isolation : la préparation qui suit peut
  // créer un worktree git, une opération qui n'est pas instantanée. Sans ce
  // garde, un signal déjà déclenché à l'entrée serait ignoré jusqu'au bout —
  // `runAgentProcess` (deuxième garde, juste avant de lancer le fils) ne
  // couvre que l'annulation survenue *pendant* cette préparation.
  if (input.signal?.aborted) {
    return abortBeforeStart(deps, input, id, paths, agentDef, depth);
  }

  // Posé avant toute création possible de worktree et conservé jusqu'à la
  // fin : `caesar gc` peut ainsi distinguer une vraie tâche en démarrage d'un
  // orphelin, même pendant la fenêtre précédant `store.create`.
  const worktreeLease = await markWorktreeInUse(deps.root, id);
  try {
  const { isolation, warning, handle, materialization, missingSection, gitignoreWarning, worktreeWasPossible } = await prepareIsolation(
    deps.root,
    id,
    input,
    agentDef,
  );
  const workspace = handle ? handle.path : input.workspace;

  // Exclusivité d'écriture sur un arbre partagé. Deux tâches `worktree` ont
  // chacune le leur et ne peuvent pas se gêner ; deux tâches `inplace` en
  // écriture partagent le même, et `diffWorkspaceStatus` — qui compare l'état
  // git avant et après — attribuerait alors à chacune les modifications de
  // l'autre. Le recoupement, qui est toute la valeur du système, deviendrait
  // faux sans que rien ne le signale.
  //
  // Seulement quand un worktree **était possible** : c'est ce qui sépare le
  // `"inplace"` choisi (opt-in `allow_inplace_write`, où l'exclusivité est le
  // prix assumé du choix) du `"inplace"` subi, faute de dépôt git utilisable.
  // Verrouiller le second sérialiserait toute délégation en écriture sur un
  // projet non versionné — au prix de la promesse de parallélisme que porte
  // `caesar_delegate` — sans offrir la moindre alternative, puisqu'aucun
  // worktree n'y est créable. Le constat d'isolation dégradée, lui, est déjà
  // au rapport.
  //
  // Ni `createSlotQueue` (qui borne un *nombre* de tâches, pas leur
  // exclusivité) ni `markWorktreeInUse` (indexé par tâche) ne répondent à
  // cette question : c'est le workspace qui est la ressource. Échec immédiat
  // nommant l'occupant, jamais une file d'attente silencieuse — l'appelant
  // saura mieux que nous s'il veut attendre ou reformuler.
  const writeLease =
    isolation === "inplace" && input.mode === "write" && worktreeWasPossible
      ? await acquireLease(join(deps.root, ".caesar", "state", "workspace-writers"), workspace, {
          label: `tâche ${id} (${agentDef.id})`,
          describeHolder: (holder) =>
            `Écriture en place impossible dans "${workspace}" : ${holder.label ?? `le processus ${holder.pid}`} y écrit déjà. ` +
            `Deux tâches en écriture dans le même arbre rendraient leurs diffs inattribuables. Attendez sa fin, ` +
            `ou laissez l'isolation à "worktree" pour que chacune ait le sien.`,
        })
      : null;
  try {

  const channel: Channel | undefined =
    input.channel === true && agentDef.capabilities.mcpInjection !== "none" ? buildChannel(paths.dir) : undefined;

  const task: Task = TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id,
    created_at: new Date().toISOString(),
    role: input.role,
    agent: agentDef.id,
    objective: input.objective,
    context: input.context ?? "",
    constraints: input.constraints ?? [],
    acceptance_criteria: input.acceptance_criteria ?? [],
    mode: input.mode,
    isolation,
    network: input.network,
    workspace,
    base_ref: handle?.baseRef,
    deadline_ms: timeoutMs,
    depth,
    report_path: paths.reportPath,
    events_path: paths.eventsPath,
    channel,
  });

  const channelAvailable = task.channel != null;
  const reportVia: ReportChannel = agentDef.preferredReportChannel(task, channelAvailable);

  let schemaFile: string | undefined;
  if (reportVia === "schema") {
    await mkdir(paths.dir, { recursive: true });
    schemaFile = join(paths.dir, "report.schema.json");
    await writeFile(schemaFile, JSON.stringify(strictReportJsonSchema(), null, 2) + "\n", "utf8");
  }

  const prompt = renderTaskPrompt(task, { reportVia, channelServerName: task.channel?.server_name });

  // Quand le CLI sait lui-même déposer son dernier message dans un fichier
  // (Codex avec `-o`, par exemple), c'est plus fiable qu'une reconstitution
  // depuis stdout : `resolveReport` le consulte en priorité au palier 2.
  const finalMessageFile = agentDef.capabilities.finalMessageFile ? join(paths.dir, FINAL_MESSAGE_FILE_NAME) : undefined;

  const plan = agentDef.build({
    task,
    paths,
    prompt,
    reportVia,
    schemaFile,
    finalMessageFile,
    // C6 de la revue finale : `BuildContext.model` était laissé absent ici,
    // silencieusement (champ jusqu'ici optionnel) — `--model`/`model:` était
    // donc accepté par le CLI, le schéma zod du tool MCP et le README, sans
    // jamais atteindre un seul des cinq adaptateurs qui le consomment.
    model: input.model,
    extraArgs: input.extraArgs ?? [],
  });
  // Le contrat minimal d'un agent externe ($CAESAR_TASK_FILE, $CAESAR_REPORT_PATH…)
  // ne dépend d'aucun adaptateur : c'est le moteur qui le garantit, ici, pour
  // tout agent, générique ou non.
  const finalPlan: SpawnPlan = { ...plan, env: { ...taskEnv(task, paths), ...plan.env } };

  await writeTask(paths, task);

  const record: TaskRecord = {
    id,
    agent: agentDef.id,
    role: input.role,
    objective: input.objective,
    status: "running",
    created_at: task.created_at,
    started_at: new Date().toISOString(),
    task_dir: paths.dir,
    workspace,
    isolation,
    mode: input.mode,
    branch: handle?.branch,
    // Persisté dès la création, et non à la fin : `caesar diff` peut être appelé
    // sur une tâche encore en cours, et doit déjà exclure ce que
    // l'orchestrateur a posé.
    ...(handle?.excluded ? { excluded_paths: handle.excluded } : {}),
    report_via: reportVia,
    depth,
  };
  await deps.store.create(record);

  // À partir d'ici, l'enregistrement existe dans le store avec le statut
  // "running" : voir I13 de la revue finale. Sans ce `try/finally`, une
  // exception inattendue entre `store.create` et le `store.update` final
  // (E/S, sous-processus git...) laissait l'enregistrement bloqué "running"
  // pour toujours — `caesar ps` le classe alors "actif" à vie, et un futur
  // `caesar cancel` sur cet identifiant enverrait un signal à un pid que l'OS a
  // pu réattribuer entre-temps (risque déjà identifié par le commentaire de
  // `pid: undefined` plus bas, mais qui ne couvrait jusqu'ici que le chemin
  // heureux). `finalized` évite un double `store.update` sur le chemin
  // heureux : la mise à jour normale, plus bas, a déjà tout dit.
  let finalized = false;
  try {
    return await runTaskBody();
  } finally {
    if (!finalized) {
      await deps.store
        .update(id, { status: "failed", ended_at: new Date().toISOString(), pid: undefined })
        .catch(() => {
          // Au mieux : ne doit jamais masquer l'exception d'origine, déjà en cours de propagation.
        });
    }
  }

  async function runTaskBody(): Promise<TaskOutcome> {
  // Capturé juste avant le lancement, quand l'isolation est "inplace" : c'est
  // le seul moyen de recouper `report.changes` avec la réalité git hors
  // worktree — voir C2/C3 de la revue finale. `captureWorkspaceStatus` rend
  // `null` sans lever si `workspace` n'est pas un dépôt git ; dans ce cas
  // comme en isolation "worktree" (où le recoupement passe par
  // `diffWorktree`), aucun recoupement n'est tenté plus bas.
  const workspaceStatusBefore = isolation === "inplace" ? await captureWorkspaceStatus(workspace) : null;

  const execute = (): Promise<RunResult> =>
    runAgentProcess({
      agent: agentDef,
      plan: finalPlan,
      paths,
      taskId: id,
      timeoutMs,
      signal: input.signal,
      onEvent: input.onEvent,
      // Renseigne le pid dès qu'il est connu, pour qu'un autre processus
      // (typiquement `caesar cancel`) puisse retrouver et signaler la tâche
      // pendant qu'elle tourne encore — voir `TaskRecord.pid`.
      onSpawn: async (pid) => {
        await deps.store.update(id, { pid });
      },
    });
  const run = deps.queue ? await deps.queue.run(execute) : await execute();

  // "Le diff git fait foi" doit tenir dans les deux isolations, pas
  // seulement "worktree" (voir C2 de la revue finale) : `diffWorkspaceStatus`
  // rejoue la même logique que `diffWorktree` (recoupement + détection
  // d'écriture ci-dessous) sans worktree, à partir de deux instantanés
  // `git status --porcelain` du workspace réel.
  const rawDiff = handle
    ? await diffWorktree(handle)
    : workspaceStatusBefore !== null
      ? await diffWorkspaceStatus(workspace, workspaceStatusBefore)
      : undefined;
  // Exclut les fichiers que l'orchestrateur lui-même a écrits dans le
  // workspace de la tâche (p. ex. `opencode.json`, voir C5 de la revue
  // finale) : sans ce filtre, un agent en lecture seule qui n'a jamais rien
  // écrit se ferait accuser d'écriture par sa propre configuration MCP, et
  // `reconcileChanges` ajouterait un constat "modification non déclarée"
  // pour un fichier que l'agent n'a jamais touché.
  const diff = rawDiff ? excludePlanFiles(rawDiff, finalPlan.files, handle ? handle.path : workspace) : undefined;

  const resolved = await resolveReport({ task, paths, run, diff, reportVia, finalMessageFile });
  let report = resolved.report;

  // Provenance de `report.changes` pour le consommateur en bout de chaîne
  // (`ReportSummary.changes_verified_by`, `caesar_await`/`caesar_delegate`) :
  // "git" dès qu'un recoupement a pu être tenté (worktree, ou inplace dans un
  // dépôt git), "declaration" seulement quand aucun `git status`/`git diff`
  // n'était possible (workspace hors dépôt git) — c'est alors la seule
  // parole de l'agent, jamais présentée comme davantage.
  const changesVerifiedBy: ChangesVerifiedBy = diff ? "git" : "declaration";

  if (diff) {
    report = reconcileChanges(report, diff);
  }

  if (task.mode === "read-only" && diff && !diff.isEmpty) {
    report = withFinding(report, {
      severity: "high",
      title: "Écriture détectée pendant une tâche en lecture seule",
      detail: `Fichiers modifiés malgré le mode lecture seule : ${diff.files.map((f) => f.path).join(", ")}`,
    });
  }

  if (warning) {
    report = withFinding(report, { severity: "low", title: "Isolation dégradée", detail: warning });
  }

  // Le diagnostic qui manquait le jour du contournement : dire, dans le
  // rapport, ce que l'atelier n'a pas pu contenir et par quelle clé le
  // corriger. Sans lui, un worktree incomplet ne se manifeste que par une
  // tâche qui échoue sans raison visible — et la réaction naturelle est de
  // renoncer à l'isolation, pas de compléter `[worktree]`.
  if (missingSection) {
    report = withFinding(report, { severity: "low", title: "Worktree sans atelier", detail: missingSection });
  }

  if (gitignoreWarning) {
    report = withFinding(report, { severity: "low", title: "Worktrees non ignorés par git", detail: gitignoreWarning });
  }

  if (materialization) {
    for (const entry of materialization.skipped) {
      report = withFinding(report, {
        severity: "low",
        title: "Chemin non matérialisé dans le worktree",
        detail: entry.detail,
        file: entry.path,
      });
    }
    if (materialization.shared.length > 0) {
      report = withFinding(report, {
        severity: "info",
        title: "Chemins partagés avec le workspace",
        detail:
          `Posés en lien symbolique, donc NON isolés : ${materialization.shared.join(", ")}. ` +
          `Ce que le sous-agent y écrit touche le workspace, et deux tâches simultanées s'y marchent dessus. ` +
          `Passez ces chemins de "link" à "copy" sous [worktree] dès que le coût de la copie le permet.`,
      });
    }
  }

  // `info` plutôt que `low` : rien n'a échoué, et ce cas est le quotidien des
  // rôles en lecture seule sur codex. Déclarer `network = "off"` sur le rôle
  // rend l'intention explicite et fait taire l'avertissement.
  if (input.networkWarning) {
    report = withFinding(report, { severity: "info", title: "Réseau non garanti", detail: input.networkWarning });
  }

  // Persisté avant la mise à jour finale du store (voir C2 de la revue
  // finale, second trou) : `writeReport` n'avait jusqu'ici qu'un seul
  // appelant en production, `submit_report` du canal MCP
  // (`packages/mcp-channel/src/server.ts`) — `runTask` calculait le rapport
  // recoupé puis le laissait mourir avec le processus. Conséquence directe :
  // `caesar_await` sur une tâche lancée par un autre processus
  // (`describeFromStore`, `packages/mcp-server`) relisait le rapport brut de
  // l'agent, jamais recoupé, ou rien du tout quand le palier retenu
  // n'écrivait pas `report.json` (paliers "extracted"/"synthesized"). Écrit
  // avant `deps.store.update` : un lecteur qui verrait le statut passer à
  // "succeeded"/"failed" trouve alors déjà le rapport final sur disque,
  // jamais une version encore non recoupée.
  await writeReport(paths, report);

  const finalStatus = deriveTaskStatus(run);
  const updated = await deps.store.update(id, {
    status: finalStatus,
    ended_at: new Date().toISOString(),
    exit_code: run.exitCode,
    report_source: resolved.source,
    changes_verified_by: changesVerifiedBy,
    // I3 de la revue finale : `status` (ci-dessus) ne reflète que l'issue du
    // processus, jamais ce que l'agent a déclaré dans son rapport — un agent
    // qui écrit {"status":"failed"} puis sort en code 0 produisait
    // `status: "succeeded"` sans que rien ne porte trace du rapport "failed"
    // dans le store. `report_status` porte ce second niveau, pour que
    // `caesar ps`, le code de sortie de `caesar run` et `caesar_status` puissent
    // croiser les deux plutôt que d'ignorer le second.
    report_status: report.status,
    // Le processus n'existe plus : un pid effacé évite à `caesar cancel` de
    // signaler un pid réutilisé entre-temps par un tout autre processus.
    pid: undefined,
  });
  finalized = true;

  return { record: updated, report, source: resolved.source, diff };
  }
  } finally {
    if (writeLease) await releaseLease(writeLease);
  }
  } finally {
    await clearWorktreeInUse(worktreeLease);
  }
}

/** Utilisée par `runTask` quand `input.taskId` est absent. Exportée pour que les
 * appelants qui préfèrent imposer leur propre identifiant (voir `RunTaskInput.taskId`)
 * réutilisent le même format plutôt que d'en tenir une seconde implémentation. */
export function generateTaskId(): string {
  return `t_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Court-circuite `runTask` quand `input.signal` est déjà déclenché à l'entrée :
 * aucune isolation n'est préparée (pas de worktree git, potentiellement
 * lent), `agentDef.build` n'est pas appelé, et surtout aucun processus n'est
 * lancé. Le résultat reste un `TaskOutcome` valide, visible par
 * `caesar ps`/`caesar logs` comme n'importe quelle autre tâche annulée.
 */
async function abortBeforeStart(
  deps: RunnerDeps,
  input: RunTaskInput,
  id: string,
  paths: TaskPaths,
  agentDef: AgentDefinition,
  depth: number,
): Promise<TaskOutcome> {
  const now = new Date().toISOString();
  // Aucune décision d'isolation réelle n'a été prise puisque `prepareIsolation`
  // n'a jamais tourné : "auto" n'a pas de sens ici, "inplace" est la valeur la
  // plus honnête (pas de worktree créé), l'isolation explicitement demandée
  // sinon.
  const isolation: Isolation = input.isolation && input.isolation !== "auto" ? input.isolation : "inplace";

  const record: TaskRecord = {
    id,
    agent: agentDef.id,
    role: input.role,
    objective: input.objective,
    status: "cancelled",
    created_at: now,
    started_at: now,
    ended_at: now,
    task_dir: paths.dir,
    workspace: input.workspace,
    isolation,
    mode: input.mode,
    report_via: "file",
    report_status: "failed",
    depth,
  };
  await deps.store.create(record);

  const report: Report = ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: id,
    status: "failed",
    summary: "Tâche annulée avant le lancement : le signal d'abandon était déjà déclenché à l'entrée de runTask.",
  });

  return { record, report, source: "synthesized" };
}

function withFinding(report: Report, finding: Finding): Report {
  return { ...report, findings: [...report.findings, finding] };
}

/**
 * Retire du diff les fichiers que l'orchestrateur a lui-même déposés dans
 * l'arborescence diffée (`plan.files`, p. ex. `opencode.json` — voir C5 de
 * la revue finale). `diff.files[].path` est relatif à `base` (racine du
 * worktree ou workspace réel selon l'isolation) ; `plan.files[].path` est
 * absolu : la comparaison résout donc chaque chemin de diff contre `base`
 * avant de le confronter à l'ensemble des chemins du plan.
 */
function excludePlanFiles(diff: WorktreeDiff, planFiles: readonly { path: string }[], base: string): WorktreeDiff {
  if (planFiles.length === 0) return diff;
  const excluded = new Set(planFiles.map((file) => resolve(file.path)));
  const files = diff.files.filter((change) => !excluded.has(resolve(base, change.path)));
  if (files.length === diff.files.length) return diff;
  return { ...diff, files, isEmpty: files.length === 0 };
}

function deriveTaskStatus(run: RunResult): TaskStatus {
  if (run.aborted) return "cancelled";
  if (run.timedOut) return "timed_out";
  return run.exitCode === 0 ? "succeeded" : "failed";
}

interface IsolationPreparation {
  isolation: Isolation;
  warning?: string;
  handle?: WorktreeHandle;
  /**
   * Ce que la matérialisation de l'atelier a posé et écarté (`[worktree]`,
   * voir `materializeUntracked`), à verser au rapport. Absent hors isolation
   * worktree, ou quand le projet ne déclare rien.
   */
  materialization?: MaterializeResult;
  /**
   * Renseigné quand le projet n'a pas de section `[worktree]` mais semble en
   * avoir besoin (dépendances installées et ignorées par git, détectées par
   * `detectUntrackedNeeds`). Le worktree est alors vide de tout ce qui
   * s'exécute, et c'est précisément ce que le rapport doit dire.
   */
  missingSection?: string;
  /** Renseigné quand `.caesar/wt/` n'est pas ignoré par git — voir `worktreesDirIgnored`. */
  gitignoreWarning?: string;
  /**
   * Un worktree était-il possible ? Faux hors dépôt git, ou dans un dépôt sans
   * le moindre commit.
   *
   * Sert à distinguer les deux `"inplace"`, qui n'engagent pas la même
   * responsabilité : celui qu'on a **choisi** alors qu'un worktree était à
   * portée, et celui auquel on s'est **résigné** faute d'alternative. Voir le
   * verrou d'écriture, dans `runTask`.
   */
  worktreeWasPossible: boolean;
}

/**
 * Applique la règle d'isolation `"auto"` (voir le brief de la tâche) puis, si
 * le résultat est `"worktree"`, crée effectivement le worktree.
 *
 * Le dernier cas de la table — lecture seule chez un agent dépourvu de mode
 * lecture seule appliqué par son CLI — est délibéré : le worktree jetable
 * transforme une promesse de prompt en garantie constatable.
 *
 * C3 de la revue finale : cette transformation était jusqu'ici un défaut de
 * la résolution `"auto"`, pas une contrainte — un `isolation: "inplace"`
 * explicite (argument de `caesar_delegate`, `role.isolation`,
 * `policy.default_isolation`) la défaisait silencieusement, y compris pour
 * le rôle `reviewer` livré par défaut. `mustForceWorktree` en fait une
 * contrainte non contournable : dès qu'un agent en lecture seule sans mode
 * natif tourne dans un dépôt git, l'isolation est forcée sur `"worktree"`
 * quelle que soit la valeur demandée — avec un `warning` explicite dans le
 * rapport quand cela contredit une demande explicite (silencieux seulement
 * quand la demande était déjà `"worktree"` ou `"auto"`, où c'était déjà le
 * résultat attendu).
 */
async function prepareIsolation(
  root: string,
  taskId: string,
  input: RunTaskInput,
  agentDef: AgentDefinition,
): Promise<IsolationPreparation> {
  const requested = input.isolation ?? "auto";
  const base = await repoRoot(input.workspace);

  // Un dépôt sans commit est un dépôt : `repoRoot` le résout. Mais aucune
  // branche n'y est née, `HEAD` ne désigne rien, et il ne peut donc servir de
  // point de départ à un worktree. Pour l'isolation, il compte comme un
  // non-dépôt — avec un remède qui, lui, diffère : un premier commit.
  const baseUsable = base !== null && (await hasCommits(base));
  const unusable =
    base === null
      ? `le workspace "${input.workspace}" n'est pas un dépôt git`
      : `le dépôt "${base}" n'a encore aucun commit : sa branche n'est pas née, "HEAD" ne désigne rien, ` +
        `et git ne sait pas créer un worktree à partir de rien`;
  const remedy =
    base === null
      ? `Initialisez un dépôt ("git init" puis un premier commit) pour isoler le travail, ou demandez explicitement "inplace" en connaissance de cause.`
      : `Faites un premier commit ("git add -A && git commit -m …", au besoin "git commit --allow-empty -m init"), ou demandez explicitement "inplace" — l'agent travaillera alors directement dans le workspace.`;

  // Avant toute décision, et non après : une tâche en écriture n'a pas le
  // droit de s'exécuter dans l'arbre de travail de l'utilisateur sans opt-in
  // assumé. Ce point-ci est le seul que *toutes* les façades traversent — y
  // compris un appel direct à `runTask` qui court-circuiterait
  // `resolveDelegation`, où le même verdict est déjà rendu, plus tôt et sans
  // rien laisser sur le disque. `decideInplaceWrite` étant pure, les deux ne
  // peuvent pas diverger.
  //
  // On lève au lieu de replier sur `"worktree"` : contrairement à
  // `mustForceWorktree` juste en dessous — qui *contient* une écriture
  // interdite — l'écriture est ici légitime et c'est son emplacement qui est
  // en cause. Déplacer sans le dire les modifications attendues par
  // l'appelant serait pire que de refuser.
  const inplaceWrite = decideInplaceWrite({
    requested,
    mode: input.mode,
    repoUsable: baseUsable,
    allowed: input.allowInplaceWrite ?? false,
    ...(base !== null ? { repo: base } : {}),
  });
  if (inplaceWrite.refused) {
    throw new Error(`Tâche "${taskId}" : ${inplaceWrite.reason} ${inplaceWrite.remedy}`);
  }

  const mustForceWorktree = input.mode === "read-only" && !agentDef.capabilities.nativeReadOnly && baseUsable;

  let isolation: Isolation;
  let warning: string | undefined;

  if (mustForceWorktree && requested !== "worktree") {
    isolation = "worktree";
    if (requested !== "auto") {
      warning =
        `Isolation "${requested}" demandée pour l'agent "${agentDef.id}" en lecture seule (sans mode natif) : ` +
        `forcée sur "worktree" pour qu'une écriture éventuelle soit contenue et détectée plutôt que seulement promise par le prompt.`;
    }
  } else if (requested !== "auto") {
    isolation = requested;
  } else if (input.mode === "write") {
    if (baseUsable) {
      isolation = "worktree";
    } else {
      isolation = "inplace";
      warning = `Isolation repliée sur "inplace" malgré le mode écriture : ${unusable}. ${remedy}`;
    }
  } else if (agentDef.capabilities.nativeReadOnly) {
    isolation = "inplace";
  } else {
    // mode === "read-only", agent sans mode natif, et mustForceWorktree est
    // faux : `baseUsable` est donc nécessairement faux ici (sinon la branche
    // ci-dessus l'aurait déjà pris en charge).
    isolation = "inplace";
    warning =
      `Isolation repliée sur "inplace" malgré l'absence de mode lecture seule natif chez "${agentDef.id}" : ${unusable}. ${remedy}`;
  }

  if (isolation !== "worktree") {
    return { isolation, warning, worktreeWasPossible: baseUsable };
  }

  if (!baseUsable) {
    // Le worktree a été demandé explicitement, ou imposé par
    // `mustForceWorktree` : y renoncer en silence retirerait la garantie même
    // pour laquelle il était exigé. On refuse, en nommant la cause et l'issue.
    throw new Error(
      `Isolation "worktree" impossible pour la tâche "${taskId}" : ${unusable}. ${remedy}`,
    );
  }

  // L'étape 0 du skill `superpowers:using-git-worktrees`, que le projet
  // supposait acquise depuis `caesar init` — un `.gitignore` réécrit à la main
  // suffit à défaire ce qu'il avait posé.
  //
  // Un constat, pas un refus, et c'est délibéré : vérifié plutôt que supposé,
  // git n'aspire *pas* le contenu d'un worktree non ignoré. Il le reconnaît
  // comme un dépôt imbriqué et n'ajoute qu'une seule entrée (un gitlink), en
  // avertissant lui-même. Le désagrément est réel, la catastrophe non — et
  // faire échouer une délégation pour une ligne de `.gitignore` manquante
  // coûterait plus cher que ce qu'elle protège.
  const gitignoreWarning = (await worktreesDirIgnored(base, taskId))
    ? undefined
    : `Le répertoire des worktrees ".caesar/wt/" n'est pas ignoré par git dans "${base}" : un "git add -A" y ajouterait ` +
      `une entrée de dépôt imbriqué. Ajoutez ".caesar/wt/" au ".gitignore" (ou relancez "caesar init --force", qui le fait).`;

  // Nommée pour être lue : dans un atelier, l'utilisateur relit ses branches.
  // Le rôle quand il y en a un, l'agent sinon — c'est ce qui distingue deux
  // ateliers ouverts en même temps sur le même objectif.
  const handle = await createWorktree(base, taskId, "HEAD", {
    objective: input.objective,
    label: input.role ?? agentDef.id,
  });

  // L'atelier : le worktree que git vient de créer ne porte que les fichiers
  // suivis. Ce qui suit y ajoute ce que le projet déclare sous `[worktree]` —
  // dépendances, `.env`, répertoires ignorés — puis lance son setup. Ici, et
  // pas ailleurs : avant `writeTask`, avant `agentDef.build`, avant tout
  // lancement. Un agent qui démarrerait dans un atelier à moitié monté
  // passerait son budget à réparer une installation au lieu de travailler.
  const request = input.worktreeSetup;
  let materialization: MaterializeResult | undefined;
  let missingSection: string | undefined;
  if (request && (request.copy.length > 0 || request.link.length > 0)) {
    materialization = await materializeUntracked(input.workspace, handle.path, request);
    if (materialization.excluded.length > 0) handle.excluded = materialization.excluded;
  } else {
    // Aucune section, mais un projet qui en aurait manifestement besoin : le
    // dire ici plutôt que de laisser l'agent buter sur un `node_modules`
    // absent. Sans ce constat, un worktree vide ne se manifeste que par une
    // tâche qui échoue sans raison visible — et la réaction naturelle est de
    // renoncer à l'isolation, pas de compléter la configuration.
    const detected = await detectUntrackedNeeds(input.workspace);
    if (detected && detected.copy.length > 0) {
      missingSection =
        `Le worktree ne contient que les fichiers suivis par git. Ce projet semble avoir besoin d'y emporter ` +
        `${detected.copy.join(", ")} — sans quoi rien ne s'y installe ni ne s'y lance. Déclarez-les sous [worktree] ` +
        `dans ".caesar/config.toml" (clé "copy"${detected.setup.length > 0 ? `, et "setup" pour ${detected.setup.join(" ; ")}` : ""}), ` +
        `ou relancez "caesar init --force" qui les détectera.`;
    }
  }

  if (request && request.setup.length > 0) {
    const setup = await runSetup(handle.path, request.setup, input.signal);
    if (setup.failure) {
      // Échec franc, avec la sortie collée : le motif doit suffire à
      // comprendre sans avoir à relancer la commande à la main.
      throw new Error(
        `Tâche "${taskId}" : la commande de préparation du worktree a échoué — "${setup.failure.command}" ` +
          `(code ${setup.failure.exitCode ?? "inconnu"}).\n${setup.failure.output}\n` +
          `Corrigez la commande sous [worktree] setup dans ".caesar/config.toml", ou retirez-la.`,
      );
    }
  }

  // `warning` peut être défini ici : voir C3 de la revue finale, le cas où
  // `mustForceWorktree` contredit une isolation explicitement demandée. Sans
  // le propager, ce dernier `return` — seul chemin de sortie une fois
  // `isolation === "worktree"` — le perdrait silencieusement, quand bien
  // même le rapport doit en porter la trace (`withFinding`, plus haut dans
  // `runTask`).
  return {
    isolation,
    warning,
    handle,
    worktreeWasPossible: true,
    ...(materialization ? { materialization } : {}),
    ...(missingSection ? { missingSection } : {}),
    ...(gitignoreWarning ? { gitignoreWarning } : {}),
  };
}
