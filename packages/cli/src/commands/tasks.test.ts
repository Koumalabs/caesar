import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@orch/core";
import { fileTaskStore, runTask } from "@orch/core";
import { makeIo, withFakeAgentAsBin, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runApply, runCancel, runDiff, runLogs, runPs } from "./tasks.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

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

describe("orch ps", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-ps-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id: "t_1",
      agent: "codex",
      objective: "objectif",
      status: "pending",
      created_at: "2026-08-09T10:00:00.000Z",
      task_dir: join(root, ".orch", "tasks", "t_1"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
      ...overrides,
    };
  }

  it("par défaut : tâches actives + dernières terminées, --json exploitable", async () => {
    const store = fileTaskStore(root);
    await store.create(record({ id: "t_running", status: "running", created_at: "2026-08-09T10:00:00.000Z" }));
    await store.create(record({ id: "t_done", status: "succeeded", created_at: "2026-08-09T09:00:00.000Z" }));

    const code = await runPs(root, { json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    const ids = parsed.tasks.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual(["t_done", "t_running"]);
  });

  it("--status filtre, un statut inconnu est une erreur d'usage", async () => {
    const store = fileTaskStore(root);
    await store.create(record({ id: "t_ok", status: "succeeded" }));
    await store.create(record({ id: "t_ko", status: "failed" }));

    const code = await runPs(root, { status: "succeeded", json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.tasks.map((t: { id: string }) => t.id)).toEqual(["t_ok"]);

    const io2 = makeIo();
    const badCode = await runPs(root, { status: "n-importe-quoi" }, io2);
    expect(badCode).toBe(EXIT_USAGE);
  });

  it("store vide : liste vide, pas d'erreur", async () => {
    const code = await runPs(root, { json: true }, io);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(io.stdoutText()).tasks).toEqual([]);
  });
});

describe("orch logs / cancel / diff / apply — sur un store peuplé par de vraies tâches", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-tasks-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("logs : tâche inconnue traitée proprement (code d'usage, message clair)", async () => {
    const code = await runLogs(root, "t_fantome", {}, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/inconnue/);
  });

  it("logs : événements normalisés d'une tâche réelle (inplace), humain et --json", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "codex", objective: "tâche de log", mode: "write", isolation: "inplace", workspace: root },
      );

      const code = await runLogs(root, outcome.record.id, {}, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("démarré");
      expect(io.stdoutText()).toContain("terminé");

      const io2 = makeIo();
      const jsonCode = await runLogs(root, outcome.record.id, { json: true }, io2);
      expect(jsonCode).toBe(EXIT_OK);
      const parsed = JSON.parse(io2.stdoutText());
      expect(parsed.events.length).toBeGreaterThan(0);
      expect(parsed.events[0].type).toBe("started");
      expect(io2.stdoutText()).not.toMatch(/\x1b\[/);
    });
  }, 20_000);

  it("logs --raw : la sortie brute du CLI de l'agent", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "codex", objective: "tâche de log brute", mode: "write", isolation: "inplace", workspace: root },
      );

      const code = await runLogs(root, outcome.record.id, { raw: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("démarrage");
      expect(io.stdoutText()).toContain("terminé");
    });
  }, 20_000);

  it("logs --follow : suit une tâche en direct jusqu'à sa fin", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const runPromise = runTask(
        { store, root },
        { agentId: "codex", objective: "tâche suivie en direct", mode: "write", isolation: "inplace", workspace: root },
      );

      const [outcome] = await Promise.all([runPromise, runLogs(root, await firstTaskId(store), { follow: true }, io)]);
      expect(outcome.record.status).toBe("succeeded");
      expect(io.stdoutText()).toContain("démarré");
      expect(io.stdoutText()).toContain("terminé");
    });

    async function firstTaskId(store: ReturnType<typeof fileTaskStore>): Promise<string> {
      for (let i = 0; i < 100; i++) {
        const [record] = await store.list({ status: ["running"] });
        if (record) return record.id;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("aucune tâche en cours trouvée à temps");
    }
  }, 20_000);

  it("cancel : tâche inconnue traitée proprement", async () => {
    const code = await runCancel(root, "t_fantome", {}, io);
    expect(code).toBe(EXIT_USAGE);
  });

  it("cancel : tâche déjà terminée — message clair, pas une erreur", async () => {
    const store = fileTaskStore(root);
    await store.create({
      id: "t_done",
      agent: "codex",
      objective: "déjà finie",
      status: "succeeded",
      created_at: new Date().toISOString(),
      task_dir: join(root, ".orch", "tasks", "t_done"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    });

    const code = await runCancel(root, "t_done", { json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.cancelled).toBe(false);
  });

  it("cancel : tâche en cours sans pid enregistré — message clair, pas une erreur", async () => {
    const store = fileTaskStore(root);
    await store.create({
      id: "t_no_pid",
      agent: "codex",
      objective: "sans pid",
      status: "running",
      created_at: new Date().toISOString(),
      task_dir: join(root, ".orch", "tasks", "t_no_pid"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    });

    const code = await runCancel(root, "t_no_pid", { json: true }, io);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(io.stdoutText()).cancelled).toBe(false);
  });

  it("cancel : pid enregistré mais processus déjà mort — message clair (ESRCH)", async () => {
    // Un processus qu'on laisse réellement se terminer : son pid est garanti libre.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid!;
    await new Promise((resolve) => dead.once("exit", resolve));

    const store = fileTaskStore(root);
    await store.create({
      id: "t_dead_pid",
      agent: "codex",
      objective: "pid mort",
      status: "running",
      created_at: new Date().toISOString(),
      task_dir: join(root, ".orch", "tasks", "t_dead_pid"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
      pid: deadPid,
    });

    const code = await runCancel(root, "t_dead_pid", { json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.cancelled).toBe(true);
    expect((await store.get("t_dead_pid"))!.status).toBe("cancelled");
  });

  it("cancel : envoie SIGTERM à une tâche réellement en cours, qui se termine promptement", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const runPromise = runTask(
        { store, root },
        {
          agentId: "codex",
          objective: "tâche qui traîne",
          mode: "write",
          isolation: "inplace",
          workspace: root,
          timeoutMs: 30_000,
          context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }),
        },
      );

      let id: string | undefined;
      for (let i = 0; i < 100 && !id; i++) {
        const [record] = await store.list({ status: ["running"] });
        if (record?.pid !== undefined) id = record.id;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(id).toBeDefined();

      const code = await runCancel(root, id!, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(JSON.parse(io.stdoutText()).cancelled).toBe(true);

      // Preuve que le SIGTERM a réellement atteint le sous-processus : la
      // tâche se termine bien avant les 30 s de `sleepMs`.
      await runPromise;
    });
  }, 20_000);

  it("diff / apply : isolation \"inplace\", rien à diffuser ni à appliquer", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "codex", objective: "sans worktree", mode: "write", isolation: "inplace", workspace: root },
      );

      const diffCode = await runDiff(root, outcome.record.id, { json: true }, io);
      expect(diffCode).toBe(EXIT_OK);
      expect(JSON.parse(io.stdoutText()).is_empty).toBe(true);

      const io2 = makeIo();
      const applyCode = await runApply(root, outcome.record.id, { json: true }, io2);
      expect(applyCode).toBe(EXIT_OK);
      expect(JSON.parse(io2.stdoutText()).applied).toBe(false);
    });
  }, 20_000);

  it("diff / apply : worktree sans conflit — le diff se retrouve appliqué au dépôt principal", async () => {
    await withFakeAgentAsBin("codex", async () => {
      await initGitRepo(root);
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "codex",
          objective: "écrire un fichier en worktree",
          mode: "write",
          isolation: "worktree",
          workspace: root,
          context: JSON.stringify({ files: [{ path: "nouveau.txt", content: "contenu\n" }] }),
        },
      );
      expect(outcome.record.isolation).toBe("worktree");

      const diffCode = await runDiff(root, outcome.record.id, { json: true }, io);
      expect(diffCode).toBe(EXIT_OK);
      const diffParsed = JSON.parse(io.stdoutText());
      expect(diffParsed.is_empty).toBe(false);
      expect(diffParsed.files.map((f: { path: string }) => f.path)).toContain("nouveau.txt");

      const io2 = makeIo();
      const applyCode = await runApply(root, outcome.record.id, { json: true }, io2);
      expect(applyCode).toBe(EXIT_OK);
      expect(JSON.parse(io2.stdoutText()).applied).toBe(true);
      expect(await readFile(join(root, "nouveau.txt"), "utf8")).toBe("contenu\n");
    });
  }, 20_000);

  it("apply : rapporte les conflits sans les masquer (code 1)", async () => {
    await withFakeAgentAsBin("codex", async () => {
      await initGitRepo(root);
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "codex",
          objective: "modifie a.txt en worktree",
          mode: "write",
          isolation: "worktree",
          workspace: root,
          context: JSON.stringify({ files: [{ path: "a.txt", content: "hello\nbranche agent\n" }] }),
        },
      );

      // Le dépôt principal diverge sur la même ligne pendant que l'agent travaille.
      await writeFile(join(root, "a.txt"), "hello\nbranche principale\n", "utf8");
      await git(root, ["add", "a.txt"]);
      await git(root, ["commit", "-q", "-m", "diverge"]);

      const code = await runApply(root, outcome.record.id, { json: true }, io);
      expect(code).toBe(EXIT_RUNTIME);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.applied).toBe(false);
      expect(parsed.conflicts).toEqual(["a.txt"]);
    });
  }, 20_000);

  it("diff / apply : tâche inconnue traitée proprement", async () => {
    expect(await runDiff(root, "t_fantome", {}, io)).toBe(EXIT_USAGE);
    const io2 = makeIo();
    expect(await runApply(root, "t_fantome", {}, io2)).toBe(EXIT_USAGE);
  });
});
