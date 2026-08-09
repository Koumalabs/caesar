import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_PROTOCOL, TaskSchema, readEvents, taskEnv, taskPaths, writeTask } from "@orch/protocol";
import type { OrchEvent, Task, TaskPaths } from "@orch/protocol";
import { isRecord, parseJsonLine } from "../adapters/json-line.js";
import type { AgentDefinition, SpawnPlan, Translation } from "../registry/types.js";
import { runAgentProcess } from "./spawn.js";

const execFileAsync = promisify(execFile);
const FAKE_AGENT = fileURLToPath(new URL("../../test/fixtures/fake-agent.mjs", import.meta.url));

/**
 * Traduction minimale reconnaissant les lignes `{"kind":"progress","message":"…"}`
 * imprimées par l'agent factice — le format de sortie propre à ce test, sans
 * rapport avec le format d'un vrai CLI.
 */
const stubAgent: AgentDefinition = {
  id: "fake",
  displayName: "Fake",
  bin: process.execPath,
  capabilities: {
    jsonEvents: true,
    outputSchema: false,
    finalMessageFile: false,
    nativeReadOnly: false,
    resume: false,
    addDir: false,
    mcpInjection: "none",
    model: false,
  },
  preferredReportChannel: () => "file",
  build: () => {
    throw new Error("non utilisé : le plan est construit directement par les tests");
  },
  translate(line: string): Translation {
    const data = parseJsonLine(line);
    if (!isRecord(data) || data["kind"] !== "progress") return { events: [] };
    const message = String(data["message"]);
    return { events: [{ type: "progress", message }], finalText: message };
  },
};

async function setupTask(dir: string, context: Record<string, unknown> = {}): Promise<{ task: Task; paths: TaskPaths }> {
  const workspace = join(dir, "workspace");
  await mkdir(workspace, { recursive: true });
  const paths = taskPaths(join(dir, "task"));
  const task = TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id: "t_spawn_test",
    created_at: new Date().toISOString(),
    agent: "fake",
    objective: "test du moteur d'exécution",
    context: JSON.stringify(context),
    mode: "write",
    isolation: "inplace",
    workspace,
    deadline_ms: 600_000,
    report_path: paths.reportPath,
    events_path: paths.eventsPath,
  });
  await writeTask(paths, task);
  return { task, paths };
}

function planFor(task: Task, paths: TaskPaths): SpawnPlan {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: task.workspace,
    env: taskEnv(task, paths),
    files: [],
  };
}

/** Confirme qu'aucun processus fake-agent ne subsiste après la résolution de runAgentProcess. */
async function expectNoOrphan(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", FAKE_AGENT]);
    expect(stdout.trim()).toBe("");
  } catch (error) {
    // pgrep sort en erreur (code 1) quand rien ne correspond : c'est le résultat attendu.
    expect((error as { code?: number }).code).toBe(1);
  }
}

describe("runAgentProcess", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orch-spawn-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("capture les événements d'un flux connu, avec started/finished et compteur croissant", async () => {
    const { task, paths } = await setupTask(dir, {});
    const seen: OrchEvent[] = [];
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onEvent: (event) => seen.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);

    const types = seen.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types.at(-1)).toBe("finished");
    expect(types.filter((t) => t === "progress")).toHaveLength(3);
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(result.eventCount).toBe(seen.length);

    // Le dernier finalText non vide l'emporte : "terminé" est le dernier message émis.
    expect(result.finalText).toBe("terminé");

    const persisted = await readEvents(paths);
    expect(persisted).toHaveLength(seen.length);
    await expectNoOrphan();
  });

  it("écrit stdout et stderr dans raw.log", async () => {
    const { task, paths } = await setupTask(dir, {});
    await runAgentProcess({ agent: stubAgent, plan: planFor(task, paths), paths, taskId: task.id, timeoutMs: 10_000 });

    const raw = await readFile(paths.rawLog, "utf8");
    expect(raw).toContain("démarrage");
    expect(raw).toContain("traitement");
    expect(raw).toContain("terminé");
  });

  it("relaie un code de sortie non nul", async () => {
    const { task, paths } = await setupTask(dir, { mode: "fail", exitCode: 7 });
    const events: OrchEvent[] = [];
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onEvent: (e) => events.push(e),
    });

    expect(result.exitCode).toBe(7);
    const finished = events.find((e) => e.type === "finished");
    expect(finished).toMatchObject({ type: "finished", status: "failed", exit_code: 7 });
    await expectNoOrphan();
  });

  it("le timeout déclenche SIGTERM et la terminaison du processus", async () => {
    const { task, paths } = await setupTask(dir, { mode: "hang" });
    const events: OrchEvent[] = [];
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 200,
      onEvent: (e) => events.push(e),
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
    await expectNoOrphan();
  });

  it("escalade vers SIGKILL quand le processus ignore SIGTERM", async () => {
    const { task, paths } = await setupTask(dir, { mode: "hang", ignoreSigterm: true });
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    await expectNoOrphan();
  }, 8000);

  it("écrit plan.stdin puis ferme l'entrée", async () => {
    const { task, paths } = await setupTask(dir, {});
    const plan: SpawnPlan = {
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(0));"],
      cwd: task.workspace,
      env: {},
      files: [],
      stdin: "bonjour depuis stdin\n",
    };

    const result = await runAgentProcess({ agent: stubAgent, plan, paths, taskId: task.id, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);

    const raw = await readFile(paths.rawLog, "utf8");
    expect(raw).toContain("bonjour depuis stdin");
  });

  it("onSpawn reçoit le pid du sous-processus avant tout traitement de sa sortie", async () => {
    const { task, paths } = await setupTask(dir, {});
    let spawnedPid: number | undefined;
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onSpawn: (pid) => {
        spawnedPid = pid;
      },
    });

    expect(spawnedPid).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });

  it("un AbortSignal annule l'exécution avant le timeout", async () => {
    const { task, paths } = await setupTask(dir, { mode: "hang" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    await expectNoOrphan();
  });
});
