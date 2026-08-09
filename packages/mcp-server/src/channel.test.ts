/**
 * Le cycle complet du canal retour (tâche 9) : une délégation qui active le
 * canal, une question posée par le sous-agent (l'agent factice, en mode
 * "ask" — voir `packages/core/test/fixtures/fake-agent.mjs`) et remontée
 * (`orch_status` et `orch_await`), une réponse (`orch_answer`), l'agent qui
 * reprend et rend son rapport via le canal (`submit_report`).
 *
 * `runTask` (`@orch/core`) est appelé directement plutôt que via
 * `orch_delegate` : ce dernier n'est pas dans le périmètre de cette tâche
 * (voir le rapport — la construction du `Channel` vit dans le runner, pas
 * dans la façade `orch_delegate`) et n'ajoute rien à ce test, qui porte sur
 * `orch_status`/`orch_await`/`orch_answer`. `orch_status`/`orch_await`
 * n'exigent pas qu'une tâche ait été lancée par `orch_delegate` — ils
 * retombent sur le store/le système de fichiers pour toute tâche connue du
 * `root` (voir `describeFromStore`), exactement comme pour une tâche lancée
 * par un autre processus.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTask } from "@orch/core";
import { withFakeAgentAsBin, withFakeHome } from "../test/support.js";
import { createSession } from "./session.js";
import { orchAnswer } from "./tools/answer.js";
import { orchAwait } from "./tools/await.js";
import { orchStatus } from "./tools/status.js";

describe("cycle complet du canal retour", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-channel-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("délégation avec canal → question remontée par orch_status et orch_await → orch_answer → l'agent reprend et rapporte via submit_report", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const runPromise = runTask(
          { store: session.store, root },
          {
            agentId: "codex",
            objective: "poser une question puis conclure",
            mode: "write",
            isolation: "inplace",
            workspace: root,
            taskId: "t_cycle",
            channel: true,
            context: JSON.stringify({ mode: "ask", question: "Quelle couleur ?", options: ["bleu", "vert"], summary: "Fait." }),
          },
        );

        // Attend que la question apparaisse, visible par orch_status — c'est
        // par là que l'agent principal apprend qu'on l'attend (voir le brief).
        let questionId: string | undefined;
        for (let i = 0; i < 400 && !questionId; i++) {
          const status = await orchStatus(session, { task_id: "t_cycle" });
          const data = status.structuredContent as { pending_questions?: Array<{ id: string; question: string }> } | undefined;
          questionId = data?.pending_questions?.[0]?.id;
          if (!questionId) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(questionId).toBeDefined();

        // orch_await, appelé pendant que la tâche est encore bloquée sur la
        // question, doit dire qu'elle attend — et quoi — pas juste "en cours".
        const awaited = await orchAwait(session, { task_ids: ["t_cycle"], timeout_ms: 50 });
        const awaitedTasks = (
          awaited.structuredContent as {
            tasks: Record<string, { pending: boolean; pending_questions: Array<{ id: string; question: string }> }>;
          }
        ).tasks;
        expect(awaitedTasks["t_cycle"]?.pending).toBe(true);
        expect(awaitedTasks["t_cycle"]?.pending_questions).toEqual([expect.objectContaining({ id: questionId, question: "Quelle couleur ?" })]);

        // L'agent principal répond.
        const answered = await orchAnswer(session, { task_id: "t_cycle", question_id: questionId!, answer: "bleu" });
        expect(answered.isError).toBeFalsy();

        // L'agent reprend et rend son rapport — via le canal (submit_report),
        // preuve la plus directe que le cycle complet a fonctionné.
        const outcome = await runPromise;
        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.source).toBe("channel");
        expect(outcome.report.summary).toContain("bleu");

        // Plus aucune question en attente une fois répondue et la tâche terminée.
        const finalStatus = await orchStatus(session, { task_id: "t_cycle" });
        expect((finalStatus.structuredContent as { pending_questions: unknown[] }).pending_questions).toEqual([]);
      }),
    );
  }, 20_000);

  it("dégradation : le canal est disponible mais jamais sollicité par l'agent, la tâche aboutit quand même par le contrat de fichier", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const outcome = await runTask(
          { store: session.store, root },
          {
            agentId: "codex",
            objective: "tâche normale, canal disponible mais ignoré",
            mode: "write",
            isolation: "inplace",
            workspace: root,
            channel: true,
            context: JSON.stringify({ summary: "fait sans jamais toucher au canal." }),
          },
        );

        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.report.status).toBe("success");
        expect(outcome.report.summary).toBe("fait sans jamais toucher au canal.");
      }),
    );
  }, 20_000);
});
