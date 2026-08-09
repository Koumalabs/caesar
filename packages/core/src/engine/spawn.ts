/**
 * Lancement du processus d'un sous-agent et normalisation de son flux de
 * sortie vers le vocabulaire commun d'`@orch/protocol`.
 *
 * C'est ici, et seulement ici, qu'un processus fils existe : le reste du
 * moteur ne connaît que des `SpawnPlan` en entrée et des `RunResult` en
 * sortie.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { OrchEvent, TaskPaths } from "@orch/protocol";
import { appendEvent, makeEvent } from "@orch/protocol";
import type { AgentDefinition, PartialEvent, SpawnPlan } from "../registry/types.js";

/** Délai de grâce entre le SIGTERM et le SIGKILL, en cas d'absence de sortie. */
const KILL_GRACE_MS = 5000;

export interface RunOptions {
  agent: AgentDefinition;
  plan: SpawnPlan;
  paths: TaskPaths;
  taskId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: OrchEvent) => void;
  /**
   * Appelé dès que le pid du sous-processus est connu, avant tout traitement
   * de sa sortie. Sert uniquement à `runner.ts` pour renseigner `TaskRecord.pid`
   * au plus tôt (voir le brief de la tâche 6, extension `orch cancel`) ; ignoré
   * si le processus échoue à démarrer (pas de pid dans ce cas).
   */
  onSpawn?: (pid: number) => void | Promise<void>;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  finalText?: string;
  eventCount: number;
  durationMs: number;
}

export async function runAgentProcess(options: RunOptions): Promise<RunResult> {
  const { agent, plan, paths, taskId, timeoutMs, signal, onEvent, onSpawn } = options;
  const startedAt = Date.now();

  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }

  await mkdir(dirname(paths.rawLog), { recursive: true });
  const rawLog = createWriteStream(paths.rawLog, { flags: "w" });

  let seq = 0;
  let finalText: string | undefined;
  let eventCount = 0;

  async function emit(partial: PartialEvent): Promise<void> {
    const event = toOrchEvent(taskId, seq++, partial);
    eventCount++;
    await appendEvent(paths, event);
    onEvent?.(event);
  }

  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  if (child.pid !== undefined) await onSpawn?.(child.pid);

  await emit({ type: "started", agent: agent.id, command: [plan.command, ...plan.args].join(" ") });

  if (plan.stdin !== undefined) child.stdin?.write(plan.stdin);
  child.stdin?.end();

  // Chaque ligne de sortie déclenche un traitement asynchrone (traduction +
  // écriture du journal) : on les sérialise sur une chaîne de promesses pour
  // ne jamais réordonner les événements ni laisser un traitement en vol
  // lorsque le flux se termine.
  let chain: Promise<void> = Promise.resolve();

  const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const stdoutClosed = new Promise<void>((resolve) => {
    stdoutRl.on("line", (line) => {
      chain = chain.then(async () => {
        rawLog.write(line + "\n");
        const { events, finalText: text } = agent.translate(line);
        if (text !== undefined && text.trim() !== "") finalText = text;
        for (const partial of events) await emit(partial);
      });
    });
    stdoutRl.once("close", () => resolve());
  });

  const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
  const stderrClosed = new Promise<void>((resolve) => {
    stderrRl.on("line", (line) => {
      chain = chain.then(async () => {
        rawLog.write(line + "\n");
      });
    });
    stderrRl.once("close", () => resolve());
  });

  let timedOut = false;
  let aborted = false;
  let hardKillTimer: NodeJS.Timeout | undefined;

  function terminate(): void {
    child.kill("SIGTERM");
    hardKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, KILL_GRACE_MS);
  }

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  function onAbort(): void {
    aborted = true;
    terminate();
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, sig) => resolve({ code, signal: sig }));
  });

  // Le fils est sorti : plus aucun risque d'orphelin à partir d'ici. On peut
  // désarmer les minuteries et attendre la fin du traitement des dernières
  // lignes déjà émises par les flux.
  clearTimeout(timeoutTimer);
  clearTimeout(hardKillTimer);
  signal?.removeEventListener("abort", onAbort);

  await Promise.all([stdoutClosed, stderrClosed]);
  await chain;

  await new Promise<void>((resolve) => rawLog.end(resolve));

  if (spawnError) {
    await emit({ type: "error", message: spawnError.message, fatal: true });
  } else if (aborted) {
    await emit({ type: "error", message: "Tâche annulée avant la fin de l'exécution.", fatal: true });
  } else if (timedOut) {
    await emit({ type: "error", message: `Délai dépassé (${timeoutMs} ms).`, fatal: true });
  } else {
    await emit({
      type: "finished",
      status: closed.code === 0 ? "success" : "failed",
      summary: "",
      exit_code: closed.code,
    });
  }

  return {
    exitCode: closed.code,
    signal: closed.signal,
    timedOut,
    aborted,
    finalText,
    eventCount,
    durationMs: Date.now() - startedAt,
  };
}

/** Complète un événement partiel avec les champs communs (protocole, seq, horodatage, tâche). */
function toOrchEvent(taskId: string, seq: number, partial: PartialEvent): OrchEvent {
  const { type, ...fields } = partial;
  // `makeEvent` est générique sur un type précis de l'union ; `partial` porte
  // un type déjà restreint à cette même union sans les champs communs
  // (`PartialEvent`, distribué variante par variante côté registre). Le
  // caster ici en `never` reporte la garantie de correspondance sur le
  // typage de `PartialEvent` lui-même plutôt que de la reperdre dans une
  // inférence générique qui ne peut pas se faire à partir d'une valeur de
  // type union.
  return makeEvent(taskId, seq, type, fields as never);
}
