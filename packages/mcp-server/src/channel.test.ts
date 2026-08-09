/**
 * Le cycle complet du canal retour (tâche 9) : une délégation qui active le
 * canal, une question posée par le sous-agent (l'agent factice, en mode
 * "ask" — voir `packages/core/test/fixtures/fake-agent.mjs`) et remontée
 * (`orch_status` et `orch_await`), une réponse (`orch_answer`), l'agent qui
 * reprend et rend son rapport via le canal (`submit_report`).
 *
 * Le premier test appelle `runTask` (`@orch/core`) directement : il isole le
 * mécanisme lui-même (`orch_status`/`orch_await`/`orch_answer` ne dépendent
 * pas d'avoir été lancées par `orch_delegate` — elles retombent sur le
 * store/le système de fichiers pour toute tâche connue du `root`, voir
 * `describeFromStore`) de la façade qui l'expose. Le second test rejoue
 * exactement le même scénario en passant par `orch_delegate`, la seule
 * façade dont dispose l'agent principal en usage réel — voir le rapport de
 * correction : le premier jet ne le faisait pas, `orch_delegate` ne
 * transmettait `channel` nulle part, ce qui rendait le mécanisme prouvé mais
 * inaccessible au produit tel qu'il est exposé.
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
import { orchDelegate } from "./tools/delegate.js";
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
        const session = await createSession(root);
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
        const session = await createSession(root);
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
        // Le palier retenu, explicitement : le runner a bien construit et
        // proposé le canal (l'agent le supporte, channel:true a été demandé)
        // — la dégradation se joue côté agent, qui ne l'utilise jamais,
        // jamais côté runner, qui a fait son travail. Ceci ne prouve pas que
        // l'agent a appelé submit_report (il ne l'a pas fait, voir le mode
        // "success" du script factice, qui écrit report.json directement) :
        // `resolveReport` étiquette "channel" dès que `task.channel` est
        // renseigné et qu'un rapport est trouvé, sans distinguer les deux
        // origines (voir son en-tête) — limite documentée, pas un bug de ce
        // test. La preuve qu'un canal *indisponible* retombe bien sur un
        // palier inférieur distinct est apportée par
        // `packages/core/src/engine/runner.test.ts` ("dégradation : une
        // résolution du binaire du canal en échec…").
        expect(outcome.record.report_via).toBe("channel");
        expect(outcome.source).toBe("channel");
      }),
    );
  }, 20_000);

  it("le même cycle, via orch_delegate — la seule façade dont dispose l'agent principal en usage réel", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await orchDelegate(session, {
          objective: "poser une question puis conclure",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          channel: true,
          context: JSON.stringify({ mode: "ask", question: "Quelle couleur ?", options: ["bleu", "vert"], summary: "Fait." }),
        });
        expect(delegated.isError).toBeFalsy();
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        let questionId: string | undefined;
        for (let i = 0; i < 400 && !questionId; i++) {
          const status = await orchStatus(session, { task_id: taskId });
          const data = status.structuredContent as { pending_questions?: Array<{ id: string; question: string }> } | undefined;
          questionId = data?.pending_questions?.[0]?.id;
          if (!questionId) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(questionId).toBeDefined();

        const answered = await orchAnswer(session, { task_id: taskId, question_id: questionId!, answer: "bleu" });
        expect(answered.isError).toBeFalsy();

        const awaited = await orchAwait(session, { task_ids: [taskId], timeout_ms: 15_000 });
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: { summary: string } }> })
          .tasks;
        expect(tasks[taskId]?.pending).toBe(false);
        expect(tasks[taskId]?.status).toBe("succeeded");
        expect(tasks[taskId]?.report?.summary).toContain("bleu");
      }),
    );
  }, 20_000);
});
