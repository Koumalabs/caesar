import { z } from "zod";
import { TASK_PROTOCOL } from "./version.js";

/**
 * Return channel coordinates. When present, the agent can talk with the
 * orchestrator along the way rather than settling for a final report.
 */
export const ChannelSchema = z.object({
  transport: z.literal("mcp-stdio"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Name under which the server is declared on the agent side. */
  server_name: z.string().default("caesar"),
});

export const TaskModeSchema = z.enum(["read-only", "write"]);
export const IsolationSchema = z.enum(["inplace", "worktree"]);

/**
 * The task entrusted to a sub-agent. Written by the orchestrator into
 * `task.json`, it is the only input an agent needs.
 */
export const TaskSchema = z.object({
  protocol: z.literal(TASK_PROTOCOL),
  id: z.string(),
  created_at: z.iso.datetime(),

  /** Requested role, when the delegation goes through a profile rather than a named agent. */
  role: z.string().optional(),
  /** Agent actually selected for execution. */
  agent: z.string(),

  /** The objective, in one sentence. This is the field a hurried human will read. */
  objective: z.string().min(1),
  /** Long-form context: code excerpts, history, links. */
  context: z.string().default(""),
  /** Explicit prohibitions and obligations. */
  constraints: z.array(z.string()).default([]),
  /** What will allow the task to be judged successful. */
  acceptance_criteria: z.array(z.string()).default([]),

  mode: TaskModeSchema,
  isolation: IsolationSchema,
  /**
   * Is the network available for this task, as far as the orchestrator
   * can assert it?
   *
   * This is not a request — the request is tri-state (`auto`/`on`/`off`) and
   * lives in the configuration; it is the result of confronting it with what
   * the selected agent actually allows (see `decideNetwork`, packages/core).
   * The brief uses it to warn the agent when the network is cut off, rather
   * than letting it burn several turns on an install doomed to fail.
   *
   * The default is `true` and is not there for convenience: the `task.json`
   * files written into `.caesar/tasks/` before this field existed must remain
   * readable — `caesar ps`, `caesar logs` and `caesar diff` all reopen them.
   */
  network: z.boolean().default(true),
  /** Agent's working root, as an absolute path. */
  workspace: z.string(),
  /** Starting git reference, filled in under worktree isolation. */
  base_ref: z.string().optional(),

  /** Time budget, in milliseconds. */
  deadline_ms: z.number().int().positive(),
  /** Delegation depth: 0 for the main agent. */
  depth: z.number().int().min(0).default(0),

  report_path: z.string(),
  events_path: z.string(),
  channel: ChannelSchema.nullish(),
});

export type Channel = z.infer<typeof ChannelSchema>;
export type TaskMode = z.infer<typeof TaskModeSchema>;
export type Isolation = z.infer<typeof IsolationSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;
