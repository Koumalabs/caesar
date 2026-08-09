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
import type { Channel, Finding, Isolation, OrchEvent, Report, ReportChannel, Task, TaskMode, TaskPaths } from "@orch/protocol";
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
} from "@orch/protocol";
import { resolveAgentDefinition } from "../registry/index.js";
import type { AgentDefinition, SpawnPlan } from "../registry/types.js";
import type { GenericAgentSpec } from "../registry/generic.js";
import type { ChangesVerifiedBy, ReportSource, TaskRecord, TaskStatus, TaskStore } from "../store.js";
import { resolveReport, reconcileChanges } from "./report.js";
import { runAgentProcess } from "./spawn.js";
import type { RunResult } from "./spawn.js";
import { captureWorkspaceStatus, createWorktree, diffWorkspaceStatus, diffWorktree, repoRoot } from "./worktree.js";
import type { Queue } from "./queue.js";
import type { WorktreeDiff, WorktreeHandle } from "./worktree.js";

const DEFAULT_TIMEOUT_MS = 600_000;

/** Nom sous lequel le canal retour est déclaré côté agent (voir `Channel.server_name`). */
const CHANNEL_SERVER_NAME = "orch";

/**
 * Chemin absolu de `dist/bin.js` dans `@orch/mcp-channel`, résolu via la
 * résolution de module Node plutôt que supposé à un chemin relatif fixe —
 * voir le brief de la tâche 9 ("résous son chemin dynamiquement plutôt que
 * de le supposer"). Cette résolution survit à une installation en dehors de
 * ce dépôt (npm, un lien global…), tant que `@orch/mcp-channel` reste une
 * dépendance déclarée de `@orch/core` (voir son `package.json`) : c'est la
 * même méthode que `resolveTuiEntry` dans
 * `packages/cli/src/commands/config.ts` pour `@orch/tui`.
 *
 * `@orch/mcp-channel` restreint son `"exports"` à `"."` (contrairement à
 * `@orch/tui`, dépourvu d'`"exports"`, que `resolveTuiEntry` peut donc
 * résoudre jusqu'à `package.json` directement) : demander la résolution de
 * `"@orch/mcp-channel/package.json"` échouerait (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
 * On résout donc l'entrée principale (`"."` → `dist/index.js`) et on
 * descend vers son voisin `dist/bin.js`, toujours émis dans le même
 * répertoire par `tsc` puisque `src/index.ts` et `src/bin.ts` sont tous deux
 * à la racine de `src/`, sans sous-répertoire.
 */
function resolveChannelEntry(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@orch/mcp-channel");
  return join(dirname(indexPath), "bin.js");
}

/**
 * Construit les coordonnées du canal retour pour une tâche. `command` est le
 * binaire Node lui-même (`process.execPath`), jamais `orch-channel` par son
 * nom ni le fichier résolu directement : ni l'un ni l'autre ne peuvent être
 * supposés exécutables ou présents dans le `PATH` du sous-agent qui le
 * lancera — voir le brief.
 *
 * Ne lève jamais : une résolution en échec (installation cassée, paquet
 * introuvable…) rend `undefined` plutôt que de faire échouer toute la
 * tâche — le canal n'est jamais un point de défaillance.
 */
function buildChannel(taskDir: string): Channel | undefined {
  try {
    const entry = resolveChannelEntry();
    return { transport: "mcp-stdio", command: process.execPath, args: [entry, taskDir], server_name: CHANNEL_SERVER_NAME };
  } catch {
    return undefined;
  }
}

/**
 * Nom du fichier où un CLI capable de `finalMessageFile` dépose son dernier
 * message, sous le répertoire de la tâche. Chemin fixe et prévisible : un
 * agent qui connaît son répertoire de tâche (`$ORCH_TASK_DIR`) peut le
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
   * façades (`orch run`, `orch_delegate`, `orch agents test`) omettre le
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
  workspace: string;
  role?: string;
  model?: string;
  timeoutMs?: number;
  depth?: number;
  /**
   * Agents génériques déclarés en configuration (`OrchConfig.agents`,
   * `[[agent]]` du TOML), consultés en plus du catalogue natif pour résoudre
   * `agentId` — voir `resolveAgentDefinition` et C1 de la revue finale.
   * Absent ou vide : catalogue natif seul (comportement inchangé). Les
   * appelants qui disposent déjà de la configuration (`orch run`,
   * `orch_delegate`, `orch agents test`) la transmettent ici plutôt que de la
   * faire recharger par `runTask`, qui n'a autrement que `deps.root`.
   */
  extraAgents?: GenericAgentSpec[];
  extraArgs?: string[];
  /**
   * Active le canal retour MCP bidirectionnel pour cette tâche, si l'agent
   * cible sait charger un serveur MCP (`capabilities.mcpInjection !==
   * "none"`) : le runner construit alors lui-même les coordonnées du
   * `Channel` (voir `buildChannel`/`resolveChannelEntry` plus bas) — binaire
   * `orch-channel` résolu dynamiquement, argument `taskDir`, nom de serveur
   * `"orch"` — aucun appelant n'a besoin d'en connaître le détail. Absent ou
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
   * (`<root>/.orch/tasks/<taskId>`) — donc de la suivre (`events.jsonl`)
   * pendant qu'elle tourne, ou de la référencer avant même que `runTask` ne
   * résolve. Absent : comportement inchangé, un identifiant est généré ici
   * comme avant. Sert notamment le CLI (`orch run`, avancement en direct) et,
   * à terme, le serveur MCP (`orch_delegate`, qui doit rendre un identifiant
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
  onEvent?: (event: OrchEvent) => void;
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
  const taskDir = join(deps.root, ".orch", "tasks", id);
  const paths = taskPaths(taskDir);

  // Vérifié ici, avant d'engager l'isolation : la préparation qui suit peut
  // créer un worktree git, une opération qui n'est pas instantanée. Sans ce
  // garde, un signal déjà déclenché à l'entrée serait ignoré jusqu'au bout —
  // `runAgentProcess` (deuxième garde, juste avant de lancer le fils) ne
  // couvre que l'annulation survenue *pendant* cette préparation.
  if (input.signal?.aborted) {
    return abortBeforeStart(deps, input, id, paths, agentDef, depth);
  }

  const { isolation, warning, handle } = await prepareIsolation(deps.root, id, input, agentDef);
  const workspace = handle ? handle.path : input.workspace;

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
  // Le contrat minimal d'un agent externe ($ORCH_TASK_FILE, $ORCH_REPORT_PATH…)
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
    report_via: reportVia,
    depth,
  };
  await deps.store.create(record);

  // À partir d'ici, l'enregistrement existe dans le store avec le statut
  // "running" : voir I13 de la revue finale. Sans ce `try/finally`, une
  // exception inattendue entre `store.create` et le `store.update` final
  // (E/S, sous-processus git...) laissait l'enregistrement bloqué "running"
  // pour toujours — `orch ps` le classe alors "actif" à vie, et un futur
  // `orch cancel` sur cet identifiant enverrait un signal à un pid que l'OS a
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
          // Best-effort : ne doit jamais masquer l'exception d'origine, déjà en cours de propagation.
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
      // (typiquement `orch cancel`) puisse retrouver et signaler la tâche
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
  // (`ReportSummary.changes_verified_by`, `orch_await`/`orch_delegate`) :
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

  // Persisté avant la mise à jour finale du store (voir C2 de la revue
  // finale, second trou) : `writeReport` n'avait jusqu'ici qu'un seul
  // appelant en production, `submit_report` du canal MCP
  // (`packages/mcp-channel/src/server.ts`) — `runTask` calculait le rapport
  // recoupé puis le laissait mourir avec le processus. Conséquence directe :
  // `orch_await` sur une tâche lancée par un autre processus
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
    // Le processus n'existe plus : un pid effacé évite à `orch cancel` de
    // signaler un pid réutilisé entre-temps par un tout autre processus.
    pid: undefined,
  });
  finalized = true;

  return { record: updated, report, source: resolved.source, diff };
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
 * `orch ps`/`orch logs` comme n'importe quelle autre tâche annulée.
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
 * explicite (argument de `orch_delegate`, `role.isolation`,
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

  const mustForceWorktree = input.mode === "read-only" && !agentDef.capabilities.nativeReadOnly && base !== null;

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
    if (base) {
      isolation = "worktree";
    } else {
      isolation = "inplace";
      warning = `Le workspace "${input.workspace}" n'est pas un dépôt git : isolation repliée sur "inplace" malgré le mode écriture.`;
    }
  } else if (agentDef.capabilities.nativeReadOnly) {
    isolation = "inplace";
  } else {
    // mode === "read-only", agent sans mode natif, et mustForceWorktree est
    // faux : `base` est donc nécessairement `null` ici (sinon la branche
    // ci-dessus l'aurait déjà pris en charge).
    isolation = "inplace";
    warning = `Le workspace "${input.workspace}" n'est pas un dépôt git : isolation repliée sur "inplace" malgré l'absence de mode lecture seule natif chez "${agentDef.id}".`;
  }

  if (isolation !== "worktree") {
    return { isolation, warning };
  }

  if (!base) {
    throw new Error(`Isolation "worktree" demandée pour la tâche "${taskId}", mais "${input.workspace}" n'est pas un dépôt git.`);
  }

  const handle = await createWorktree(base, taskId);
  return { isolation, handle };
}
