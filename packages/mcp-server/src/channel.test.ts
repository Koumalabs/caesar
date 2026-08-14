/**
 * The full return-channel cycle (task 9): a delegation that enables the
 * channel, a question asked by the subagent (the fake agent, in "ask" mode
 * — see `packages/core/test/fixtures/fake-agent.mjs`) and surfaced
 * (`caesar_status` and `caesar_await`), an answer (`caesar_answer`), the
 * agent resuming and delivering its report via the channel
 * (`submit_report`).
 *
 * The first test calls `runTask` (`@caesar/core`) directly: it isolates the
 * mechanism itself (`caesar_status`/`caesar_await`/`caesar_answer` do not
 * depend on having been started by `caesar_delegate` — they fall back on
 * the store/filesystem for any task known under `root`, see
 * `describeFromStore`) from the facade exposing it. The second test replays
 * exactly the same scenario through `caesar_delegate`, the only facade the
 * main agent has in real use — see the fix report: the first draft did not,
 * `caesar_delegate` passed `channel` along nowhere, which left the
 * mechanism proven yet unreachable in the product as exposed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTask } from "@caesar/core";
import { withFakeAgentAsBin, withFakeHome } from "../test/support.js";
import { createSession } from "./session.js";
import { caesarAnswer } from "./tools/answer.js";
import { caesarAwait } from "./tools/await.js";
import { caesarDelegate } from "./tools/delegate.js";
import { caesarStatus } from "./tools/status.js";

describe("full return-channel cycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-channel-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("delegation with channel → question surfaced by caesar_status and caesar_await → caesar_answer → the agent resumes and reports via submit_report", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const runPromise = runTask(
          { store: session.store, root },
          {
            agentId: "codex",
            objective: "ask a question then conclude",
            mode: "write",
            isolation: "inplace",
            workspace: root,
            taskId: "t_cycle",
            channel: true,
            context: JSON.stringify({ mode: "ask", question: "Which color?", options: ["blue", "green"], summary: "Done." }),
          },
        );

        // Waits for the question to appear, visible via caesar_status — that
        // is how the main agent learns it is being waited on (see the brief).
        let questionId: string | undefined;
        for (let i = 0; i < 400 && !questionId; i++) {
          const status = await caesarStatus(session, { task_id: "t_cycle" });
          const data = status.structuredContent as { pending_questions?: Array<{ id: string; question: string }> } | undefined;
          questionId = data?.pending_questions?.[0]?.id;
          if (!questionId) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(questionId).toBeDefined();

        // caesar_await, called while the task is still blocked on the
        // question, must say it is waiting — and on what — not just "running".
        const awaited = await caesarAwait(session, { task_ids: ["t_cycle"], timeout_ms: 50 });
        const awaitedTasks = (
          awaited.structuredContent as {
            tasks: Record<string, { pending: boolean; pending_questions: Array<{ id: string; question: string }> }>;
          }
        ).tasks;
        expect(awaitedTasks["t_cycle"]?.pending).toBe(true);
        expect(awaitedTasks["t_cycle"]?.pending_questions).toEqual([expect.objectContaining({ id: questionId, question: "Which color?" })]);

        // The main agent answers.
        const answered = await caesarAnswer(session, { task_id: "t_cycle", question_id: questionId!, answer: "blue" });
        expect(answered.isError).toBeFalsy();

        // The agent resumes and delivers its report — via the channel
        // (submit_report), the most direct proof the full cycle worked.
        const outcome = await runPromise;
        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.source).toBe("channel");
        expect(outcome.report.summary).toContain("blue");

        // No more pending questions once answered and the task is done.
        const finalStatus = await caesarStatus(session, { task_id: "t_cycle" });
        expect((finalStatus.structuredContent as { pending_questions: unknown[] }).pending_questions).toEqual([]);
      }),
    );
  }, 20_000);

  it("degradation: the channel is available but never used by the agent, the task still completes through the file contract", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const outcome = await runTask(
          { store: session.store, root },
          {
            agentId: "codex",
            objective: "normal task, channel available but ignored",
            mode: "write",
            isolation: "inplace",
            workspace: root,
            channel: true,
            context: JSON.stringify({ summary: "done without ever touching the channel." }),
          },
        );

        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.report.status).toBe("success");
        expect(outcome.report.summary).toBe("done without ever touching the channel.");
        // The tier retained, explicitly: the runner did build and offer the
        // channel (the agent supports it, channel:true was requested) — the
        // degradation plays out on the agent side, which never uses it,
        // never on the runner side, which did its job. This does not prove
        // the agent called submit_report (it did not, see the fake script's
        // "success" mode, which writes report.json directly):
        // `resolveReport` labels "channel" as soon as `task.channel` is set
        // and a report is found, without distinguishing the two origins
        // (see its header) — a documented limitation, not a bug in this
        // test. The proof that an *unavailable* channel does fall back to a
        // distinct lower tier is provided by
        // `packages/core/src/engine/runner.test.ts` ("degradation: a failed
        // resolution of the channel binary…").
        expect(outcome.record.report_via).toBe("channel");
        expect(outcome.source).toBe("channel");
      }),
    );
  }, 20_000);

  it("the same cycle, via caesar_delegate — the only facade the main agent has in real use", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, {
          objective: "ask a question then conclude",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          channel: true,
          context: JSON.stringify({ mode: "ask", question: "Which color?", options: ["blue", "green"], summary: "Done." }),
        });
        expect(delegated.isError).toBeFalsy();
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        let questionId: string | undefined;
        for (let i = 0; i < 400 && !questionId; i++) {
          const status = await caesarStatus(session, { task_id: taskId });
          const data = status.structuredContent as { pending_questions?: Array<{ id: string; question: string }> } | undefined;
          questionId = data?.pending_questions?.[0]?.id;
          if (!questionId) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(questionId).toBeDefined();

        const answered = await caesarAnswer(session, { task_id: taskId, question_id: questionId!, answer: "blue" });
        expect(answered.isError).toBeFalsy();

        const awaited = await caesarAwait(session, { task_ids: [taskId], timeout_ms: 15_000 });
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: { summary: string } }> })
          .tasks;
        expect(tasks[taskId]?.pending).toBe(false);
        expect(tasks[taskId]?.status).toBe("succeeded");
        expect(tasks[taskId]?.report?.summary).toContain("blue");
      }),
    );
  }, 20_000);
});
