import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_PROTOCOL } from "@orch/protocol";
import { fileTaskStore, type TaskStore } from "../store.js";
import { createQueue } from "./queue.js";

const execFileAsync = promisify(execFile);

/**
 * Remplace le registre fixe (les cinq agents réels) par une version qui sait
 * en plus résoudre `"fake-agent"` / `"fake-agent-native-ro"` vers l'agent
 * factice de test, construit avec `createGenericAgent` — exactement comme le
 * brief le demande ("il se déclare au registre via GenericAgentSpec").
 *
 * Le registre lui-même (`../registry/index.ts`) n'est pas modifié : task 3
 * l'a livré et testé, ce module se contente de le consommer, y compris dans
 * ce contournement de test.
 */
vi.mock("../registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registry/index.js")>();
  const { createGenericAgent } = await import("../registry/generic.js");
  const { fileURLToPath } = await import("node:url");
  const fakeAgentPath = fileURLToPath(new URL("../../test/fixtures/fake-agent.mjs", import.meta.url));

  const fakeAgentDefinition = createGenericAgent({
    id: "fake-agent",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { nativeReadOnly: false },
  });
  const fakeAgentNativeReadOnlyDefinition = createGenericAgent({
    id: "fake-agent-native-ro",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { nativeReadOnly: true },
  });
  const fakeAgentFinalMessageDefinition = createGenericAgent({
    id: "fake-agent-final-message",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { finalMessageFile: true },
  });

  return {
    ...actual,
    resolveAgentDefinition: (id: string) => {
      if (id === "fake-agent") return fakeAgentDefinition;
      if (id === "fake-agent-native-ro") return fakeAgentNativeReadOnlyDefinition;
      if (id === "fake-agent-final-message") return fakeAgentFinalMessageDefinition;
      return actual.resolveAgentDefinition(id);
    },
  };
});

const { runTask } = await import("./runner.js");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "orch-test@example.com"]);
  await git(root, ["config", "user.name", "Orch Test"]);
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

describe("runTask", () => {
  let root: string;
  let store: TaskStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-runner-")));
    store = fileTaskStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("règle d'isolation \"auto\"", () => {
    it("write + dépôt git → worktree", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("worktree");
      expect(outcome.record.branch).toBe(`orch/${outcome.record.id}`);
      expect(outcome.record.workspace).toBe(join(root, ".orch", "wt", outcome.record.id));
      expect(outcome.record.status).toBe("succeeded");
      expect(outcome.report.status).toBe("success");
      expect(outcome.report.findings).toEqual([]);
    });

    it("write + workspace hors dépôt git → inplace, avec un constat d'isolation dégradée", async () => {
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.branch).toBeUndefined();
      expect(outcome.record.workspace).toBe(root);
      expect(outcome.report.findings).toEqual([expect.objectContaining({ severity: "low" })]);
    });

    it("lecture seule + mode natif appliqué par le CLI → inplace", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent-native-ro", objective: "lire", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.workspace).toBe(root);
      expect(outcome.diff).toBeUndefined();
    });

    it("lecture seule + agent sans mode natif → worktree forcé", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "lire", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("worktree");
      expect(outcome.diff).toBeDefined();
      expect(outcome.diff!.isEmpty).toBe(true);
    });

    it("worktree demandé explicitement hors dépôt git : échoue clairement plutôt que de dégrader silencieusement", async () => {
      await expect(
        runTask(
          { store, root },
          { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root, isolation: "worktree" },
        ),
      ).rejects.toThrow(/dépôt git/);
    });
  });

  it("une tâche read-only dont l'agent écrit produit un finding de sévérité high, nommant le fichier", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "lecture seule qui n'en est pas une",
        mode: "read-only",
        workspace: root,
        context: JSON.stringify({ files: [{ path: "sournois.txt", content: "je n'aurais pas dû écrire ça" }] }),
      },
    );

    expect(outcome.diff!.isEmpty).toBe(false);
    const high = outcome.report.findings.filter((f) => f.severity === "high");
    expect(high).toHaveLength(1);
    expect(high[0]!.detail).toContain("sournois.txt");
  });

  it("une tâche dont l'agent n'écrit aucun rapport produit un rapport synthétisé", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "agent qui ignore le contrat",
        mode: "write",
        workspace: root,
        context: JSON.stringify({ mode: "silent" }),
      },
    );

    expect(outcome.source).toBe("synthesized");
    expect(outcome.record.status).toBe("succeeded");
    expect(outcome.report.status).toBe("success");
  });

  it("un agent capable de finalMessageFile est câblé de bout en bout : le runner lui désigne le fichier, il l'utilise", async () => {
    await initGitRepo(root);
    const embedded = {
      protocol: REPORT_PROTOCOL,
      task_id: "peu importe, resolveReport ne s'y fie pas",
      status: "success",
      summary: "déposé par le CLI dans final-message.txt, jamais dans report.json",
      changes: [],
    };
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent-final-message",
        objective: "agent qui rapporte par fichier de message final",
        mode: "write",
        workspace: root,
        // "silent" : aucun report.json écrit, pour prouver que le rapport
        // vient bien de final-message.txt et de rien d'autre.
        context: JSON.stringify({ mode: "silent", finalMessage: JSON.stringify(embedded) }),
      },
    );

    expect(outcome.source).toBe("extracted");
    expect(outcome.report.summary).toBe("déposé par le CLI dans final-message.txt, jamais dans report.json");
  });

  it("renseigne le pid du sous-processus pendant l'exécution puis l'efface à la fin", async () => {
    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "vérifie le cycle de vie du pid",
        mode: "write",
        workspace: root,
        isolation: "inplace",
        timeoutMs: 300,
        context: JSON.stringify({ mode: "hang", sleepMs: 5000 }),
      },
    );

    // Attend que le pid apparaisse dans le store, pendant que la tâche tourne encore.
    let seenPid: number | undefined;
    for (let i = 0; i < 100 && seenPid === undefined; i++) {
      const records = await store.list({ status: ["running"] });
      seenPid = records[0]?.pid;
      if (seenPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(seenPid).toBeGreaterThan(0);

    const outcome = await runPromise;
    expect(outcome.record.pid).toBeUndefined();
  });

  it("taskId fourni par l'appelant : utilisé tel quel, sans en générer un autre", async () => {
    const outcome = await runTask(
      { store, root },
      { agentId: "fake-agent", objective: "identifiant imposé", mode: "write", workspace: root, taskId: "t_imposed" },
    );

    expect(outcome.record.id).toBe("t_imposed");
    expect(outcome.record.task_dir).toBe(join(root, ".orch", "tasks", "t_imposed"));
    expect(await store.get("t_imposed")).not.toBeNull();
  });

  it("un signal déjà déclenché à l'entrée n'engage même pas l'isolation : aucun worktree créé, statut cancelled", async () => {
    await initGitRepo(root);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "signal déjà abandonné avant le lancement",
        // write + dépôt git : la règle d'isolation "auto" aurait normalement
        // créé un worktree. Le garde doit intervenir avant que cela n'arrive.
        mode: "write",
        workspace: root,
        signal: controller.signal,
      },
    );

    expect(outcome.record.status).toBe("cancelled");
    expect(outcome.record.branch).toBeUndefined();
    expect(outcome.diff).toBeUndefined();
    expect(outcome.report.status).toBe("failed");
    await expect(access(join(root, ".orch", "wt"))).rejects.toThrow();
  });

  it("onEvent reçoit les événements au fil de l'eau, avant que runTask ne résolve", async () => {
    const seenBeforeResolution: string[] = [];
    let resolved = false;

    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "événements en direct",
        mode: "write",
        workspace: root,
        onEvent: (event) => seenBeforeResolution.push(event.type),
      },
    ).then((outcome) => {
      resolved = true;
      return outcome;
    });

    // Le premier événement ("started") doit être observable avant même que
    // `runTask` ait fini de résoudre — c'est ce qui distingue un flux en
    // direct d'une relecture après coup.
    for (let i = 0; i < 100 && seenBeforeResolution.length === 0; i++) {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
    }
    expect(seenBeforeResolution).toContain("started");
    expect(resolved).toBe(false);

    const outcome = await runPromise;
    expect(outcome.record.status).toBe("succeeded");
    expect(seenBeforeResolution).toContain("finished");
  });

  it("un AbortSignal annulé pendant l'exécution interrompt la tâche sans laisser de processus fils", async () => {
    const controller = new AbortController();
    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "tâche interrompue via AbortSignal",
        mode: "write",
        workspace: root,
        signal: controller.signal,
        context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }),
      },
    );

    // Laisse le sous-processus réellement démarrer avant d'annuler.
    for (let i = 0; i < 100; i++) {
      const [record] = await store.list({ status: ["running"] });
      if (record?.pid !== undefined) break;
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 20));
    }
    controller.abort();

    const outcome = await runPromise;
    expect(outcome.record.status).toBe("cancelled");
    expect(outcome.record.pid).toBeUndefined();
  });

  it("recoupe une déclaration mensongère avec le diff réel de bout en bout", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "agent qui ment sur ses changements",
        mode: "write",
        workspace: root,
        context: JSON.stringify({
          files: [{ path: "reel.txt", content: "vraiment écrit" }],
          declaredChanges: [{ path: "invente.txt", action: "modified", summary: "n'existe pas" }],
        }),
      },
    );

    expect(outcome.source).toBe("file");
    expect(outcome.report.changes).toEqual([{ path: "reel.txt", action: "created", summary: "" }]);
    const files = outcome.report.findings.map((f) => f.file).sort();
    expect(files).toEqual(["invente.txt", "reel.txt"]);
  });
});
