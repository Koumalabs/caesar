import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markWorktreeInUse } from "@orch/core";
import { writeQuestion } from "@orch/mcp-channel";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchAwait } from "./await.js";
import { orchDelegate } from "./delegate.js";

describe("orch_await", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-await-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cycle complet orch_delegate puis orch_await, jusqu'au rapport", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await orchDelegate(session, {
          objective: "écrire un fichier",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ summary: "fait." }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const awaited = await orchAwait(session, { task_ids: [taskId] });
        expect(awaited.isError).toBeFalsy();
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: { status: string; summary: string } }> }).tasks;
        expect(tasks[taskId]?.status).toBe("succeeded");
        expect(tasks[taskId]?.pending).toBe(false);
        expect(tasks[taskId]?.report?.status).toBe("success");
        expect(tasks[taskId]?.report?.summary).toBe("fait.");
      }),
    );
  }, 20_000);

  it("deux délégations en parallèle sont réellement exécutées en même temps, pas l'une après l'autre", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);

        // `sleepMs`, depuis la correction du constat 1 de la revue de la
        // tâche 7, retarde aussi le mode "success" de l'agent factice (pas
        // seulement "hang") — voir `fake-agent.mjs`. Sans ça, les deux
        // tâches se termineraient quasi instantanément quel que soit l'ordre
        // d'exécution, et aucune mesure ci-dessous ne distinguerait un
        // déroulement parallèle d'un déroulement séquentiel.
        const delayMs = 1_000;
        const startedAt = Date.now();
        const [first, second] = await Promise.all([
          orchDelegate(session, {
            objective: "première",
            agent: "codex",
            mode: "write",
            isolation: "inplace",
            context: JSON.stringify({ summary: "première faite.", sleepMs: delayMs }),
          }),
          orchDelegate(session, {
            objective: "seconde",
            agent: "codex",
            mode: "write",
            isolation: "inplace",
            context: JSON.stringify({ summary: "seconde faite.", sleepMs: delayMs }),
          }),
        ]);
        const firstId = (first.structuredContent as { task_id: string }).task_id;
        const secondId = (second.structuredContent as { task_id: string }).task_id;
        expect(firstId).not.toBe(secondId);

        // Preuve n°1, par constat d'état plutôt que par chronométrage — donc
        // insensible à la charge de la machine (voir la revue de la
        // tâche 7) : pendant que les deux tâches dorment, il doit exister un
        // instant où le store les montre **simultanément** "running". Un
        // déroulement séquentiel (la seconde ne démarrant qu'une fois la
        // première terminée) ne produit jamais cet instant : on y verrait la
        // première passer à "succeeded" avant même que la seconde n'existe
        // dans le store à l'état "running" — la boucle ci-dessous
        // épuiserait alors ses itérations sans jamais voir les deux
        // "running" au même instant, et l'assertion qui suit échouerait.
        let observedBothRunning = false;
        for (let i = 0; i < 400 && !observedBothRunning; i++) {
          const [r1, r2] = await Promise.all([session.store.get(firstId), session.store.get(secondId)]);
          if (r1?.status === "running" && r2?.status === "running") {
            observedBothRunning = true;
          } else {
            await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
          }
        }
        expect(observedBothRunning).toBe(true);

        // Preuve n°2, chronométrée, en complément de la preuve n°1 (qui
        // reste la seule dont la marge ne dépend pas de la charge de la
        // machine) : l'attente conjointe des deux tâches ne coûte que le
        // plus long des deux délais, pas leur somme. Avec delayMs = 1000 ms
        // chacune, un déroulement séquentiel prendrait au moins ~2000 ms
        // (plus le coût de démarrage des deux processus) ; le seuil
        // ci-dessous l'exclut franchement tout en laissant une marge large
        // au cas parallèle réel (mesuré entre ~1000 et ~1500 ms selon la
        // charge de la machine lors du calibrage de ce test).
        const awaited = await orchAwait(session, { task_ids: [firstId, secondId], timeout_ms: 10_000 });
        const elapsedMs = Date.now() - startedAt;

        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; report?: { summary: string } }> }).tasks;
        expect(tasks[firstId]?.status).toBe("succeeded");
        expect(tasks[secondId]?.status).toBe("succeeded");
        expect(tasks[firstId]?.report?.summary).toBe("première faite.");
        expect(tasks[secondId]?.report?.summary).toBe("seconde faite.");
        expect(elapsedMs).toBeLessThan(1_800);
      }),
    );
  }, 20_000);

  it("un délai dépassé rend l'état partiel plutôt que d'attendre indéfiniment", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await orchDelegate(session, {
          objective: "tâche longue",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ mode: "hang", sleepMs: 5_000 }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const startedAt = Date.now();
        const awaited = await orchAwait(session, { task_ids: [taskId], timeout_ms: 200 });
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(2_000);
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: unknown }> }).tasks;
        expect(tasks[taskId]?.pending).toBe(true);
        expect(tasks[taskId]?.report).toBeUndefined();
        expect(["pending", "running"]).toContain(tasks[taskId]?.status);

        // Nettoyage.
        const entry = session.tasks.get(taskId);
        entry?.controller.abort();
        await entry?.promise;
      }),
    );
  }, 20_000);

  it("un task_id totalement inconnu est signalé comme tel, sans faire échouer le reste du lot", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await orchDelegate(session, {
          objective: "tâche",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const awaited = await orchAwait(session, { task_ids: [taskId, "t_inexistant"] });
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string }> }).tasks;
        expect(tasks["t_inexistant"]?.status).toBe("unknown");
        expect(tasks[taskId]?.status).toBe("succeeded");
      }),
    );
  }, 20_000);

  it("une tâche bloquée sur une question dit qu'elle attend, et quoi — pas juste \"en cours\"", async () => {
    const taskDir = join(root, ".orch", "tasks", "t_q");
    await mkdir(taskDir, { recursive: true });
    const session = await createSession(root);
    await session.store.create({
      id: "t_q",
      agent: "codex",
      objective: "obj",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      task_dir: taskDir,
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "channel",
      depth: 0,
    });
    await writeQuestion(taskDir, { id: "q1", question: "Quelle branche ?", options: [], asked_at: new Date().toISOString() });

    // `t_q` n'a jamais été lancée par cette session (pas d'entrée dans
    // `session.tasks`) : `orchAwait` retombe sur le store/le système de
    // fichiers, exactement comme pour une tâche lancée par un autre
    // processus (`orch run`, un précédent serveur MCP…) — voir `describeFromStore`.
    const awaited = await orchAwait(session, { task_ids: ["t_q"] });
    const tasks = (
      awaited.structuredContent as {
        tasks: Record<string, { pending: boolean; pending_questions: Array<{ id: string; question: string }> }>;
      }
    ).tasks;
    expect(tasks["t_q"]?.pending).toBe(true);
    expect(tasks["t_q"]?.pending_questions).toEqual([expect.objectContaining({ id: "q1", question: "Quelle branche ?" })]);
  });

  /**
   * Une tâche laissée par un serveur MCP qu'on a depuis fermé : son
   * enregistrement dit "running" pour toujours, faute d'un processus vivant
   * pour le conclure. La rendre `pending: true` reviendrait à conseiller
   * d'attendre indéfiniment quelque chose que plus personne ne fait.
   */
  it("une tâche dont l'orchestrateur a disparu est conclue, pas rendue en attente", async () => {
    const taskDir = join(root, ".orch", "tasks", "t_abandonnee");
    await mkdir(taskDir, { recursive: true });
    const session = await createSession(root);
    await session.store.create({
      id: "t_abandonnee",
      agent: "codex",
      objective: "obj",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      task_dir: taskDir,
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "channel",
      depth: 0,
    });
    // Le marqueur qu'un orchestrateur tué laisse derrière lui.
    const lease = await markWorktreeInUse(root, "t_abandonnee");
    await writeFile(lease.path, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");

    const awaited = await orchAwait(session, { task_ids: ["t_abandonnee"] });

    const tasks = (
      awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: { status: string; summary: string } }> }
    ).tasks;
    expect(tasks["t_abandonnee"]?.pending).toBe(false);
    expect(tasks["t_abandonnee"]?.status).toBe("failed");
    expect(tasks["t_abandonnee"]?.report?.summary).toContain("disparu");
  });
});
