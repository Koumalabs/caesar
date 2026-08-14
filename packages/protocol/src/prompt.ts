import { REPORT_PROTOCOL, ENV } from "./version.js";
import type { Task } from "./task.js";

/**
 * How the agent is expected to deliver its report, from most reliable to most
 * degraded. The engine picks the best tier the targeted agent can honor.
 */
export type ReportChannel =
  /** The agent calls the `submit_report` tool of the return channel. */
  | "channel"
  /** The provider natively constrains the final response with a JSON Schema. */
  | "schema"
  /** The agent writes the report file itself. */
  | "file";

export interface PromptOptions {
  reportVia: ReportChannel;
  /** Name of the MCP server as declared on the agent side, used to name the tools. */
  channelServerName?: string;
}

/**
 * Renders the task as a prompt.
 *
 * The text is in English: it is a contract addressed to models and meant to
 * be reused by third-party integrations. The task's fields, however, are
 * carried over verbatim — an objective written in French stays that way.
 */
export function renderTaskPrompt(task: Task, options: PromptOptions): string {
  const sections: string[] = [];

  sections.push(
    [
      "You are running as a delegated sub-agent inside an orchestrator.",
      `Your task id is ${task.id}. Work only toward the objective below.`,
    ].join(" "),
  );

  sections.push(`## Objective\n${task.objective}`);

  if (task.context.trim()) {
    sections.push(`## Context\n${task.context.trim()}`);
  }

  const constraints = [...task.constraints];
  if (task.mode === "read-only") {
    constraints.unshift("Do NOT modify, create or delete any file. This is a read-only investigation.");
  }
  // An agent unaware of this spends several turns on an `npm install` its
  // sandbox will never let succeed. `task.network` is only false when the
  // orchestrator *knows* the network is cut off: where it does not know
  // (`claude`, `agy`, an agent declared without network arguments), the field
  // stays true and nothing is asserted here.
  if (!task.network) {
    constraints.push(
      "No network access: this sandbox has networking disabled. Do not attempt to install packages, clone repositories or fetch URLs — prefer what is already vendored, and report the need instead of retrying.",
    );
  }
  constraints.push(`Stay inside the workspace: ${task.workspace}`);
  sections.push(`## Constraints\n${bullets(constraints)}`);

  if (task.acceptance_criteria.length > 0) {
    sections.push(`## Acceptance criteria\n${bullets(task.acceptance_criteria)}`);
  }

  sections.push(`## Reporting\n${reportingInstructions(task, options)}`);

  return sections.join("\n\n");
}

function reportingInstructions(task: Task, options: PromptOptions): string {
  const shape = [
    "The report is a JSON object with this shape:",
    "",
    "```json",
    JSON.stringify(exampleReport(task.id), null, 2),
    "```",
    "",
    bullets([
      "`status`: `success` when the acceptance criteria are met, `partial` when some work remains, `failed` when you could not proceed, `blocked` when a decision outside your scope is required — in that case fill `questions`.",
      "`summary`: two or three sentences. What you did, and what is still open.",
      "`changes`: every file you touched. The orchestrator cross-checks this against the git diff.",
      "`findings`: anything you noticed that the caller should know, even outside the objective.",
      "Arrays you have nothing to put in may be omitted.",
    ]),
  ].join("\n");

  switch (options.reportVia) {
    case "channel": {
      const server = options.channelServerName ?? "caesar";
      return [
        `When you are done, call the \`submit_report\` tool of the \`${server}\` MCP server with your report.`,
        `You may call \`report_progress\` along the way, and \`ask_orchestrator\` if you are blocked on a decision.`,
        `If that server is unreachable, fall back to writing the report to \`${task.report_path}\`.`,
        "",
        shape,
      ].join("\n");
    }
    case "schema":
      return [
        "Your final response must be the report object itself, and nothing else.",
        "",
        shape,
      ].join("\n");
    case "file":
      return [
        `When you are done, write your report to this exact path:`,
        "",
        `    ${task.report_path}`,
        "",
        `That path is also available as \`$${ENV.reportPath}\` in your environment.`,
        "Write the file as your very last action, then stop.",
        "",
        shape,
      ].join("\n");
  }
}

function exampleReport(taskId: string): Record<string, unknown> {
  return {
    protocol: REPORT_PROTOCOL,
    task_id: taskId,
    status: "success",
    summary: "…",
    changes: [{ path: "src/foo.ts", action: "modified", summary: "…" }],
    findings: [{ severity: "medium", title: "…", file: "src/bar.ts", detail: "…" }],
    questions: [],
    next_steps: [],
  };
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
