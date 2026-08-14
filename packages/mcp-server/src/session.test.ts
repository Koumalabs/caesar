/**
 * `launchTask` porte la garantie centrale du point de vigilance de la
 * tâche 7 : une tâche lancée sans être attendue (`caesar_delegate`) ne doit
 * jamais produire un rejet de promesse non intercepté, quelle que soit la
 * façon dont `runTask` échoue — y compris quand le store lui-même, censé
 * recueillir la trace de repli, est indisponible.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, launchTask } from "./session.js";

describe("launchTask", () => {
  let root: string;
  let unhandled: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-session-"));
    unhandled = [];
    onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(async () => {
    process.off("unhandledRejection", onUnhandledRejection);
    // Si ce test a laissé passer un rejet non intercepté, c'est justement le
    // scénario que ce fichier existe pour empêcher.
    expect(unhandled).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("un échec avant l'écriture du store (isolation \"worktree\" hors dépôt git) rend un TaskOutcome synthétisé, jamais un rejet", async () => {
    const session = await createSession(root);
    const controller = new AbortController();

    const entry = launchTask(
      session,
      {
        agentId: "codex",
        objective: "tâche",
        mode: "write",
        isolation: "worktree", // `root` n'est pas un dépôt git : `prepareIsolation` lève avant `store.create`.
        workspace: root,
        taskId: "t_session_test_1",
      },
      controller,
    );

    const outcome = await entry.promise;
    expect(outcome.source).toBe("synthesized");
    expect(outcome.record.status).toBe("failed");
    expect(outcome.report.status).toBe("failed");
    expect(outcome.report.summary).toMatch(/interrompue/);

    const stored = await session.store.get("t_session_test_1");
    expect(stored?.status).toBe("failed");

    // Laisse une chance à un éventuel rejet non intercepté de se manifester
    // avant que le test ne se termine.
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));
  });

  it("un échec même quand le store est indisponible retombe sur un TaskOutcome purement en mémoire, jamais un rejet", async () => {
    // Bloque l'écriture du store : un fichier occupe l'emplacement où le
    // store voudrait créer son répertoire (`.caesar/state/tasks/`).
    await mkdir(join(root, ".caesar", "state"), { recursive: true });
    await writeFile(join(root, ".caesar", "state", "tasks"), "occupé", "utf8");

    const session = await createSession(root);
    const controller = new AbortController();

    const entry = launchTask(
      session,
      {
        agentId: "codex",
        objective: "tâche",
        mode: "write",
        isolation: "worktree",
        workspace: root,
        taskId: "t_session_test_2",
      },
      controller,
    );

    const outcome = await entry.promise;
    expect(outcome.source).toBe("synthesized");
    expect(outcome.record.status).toBe("failed");
    expect(outcome.report.status).toBe("failed");

    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));
  });
});
