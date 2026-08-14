import { z } from "zod";
import { EVENT_PROTOCOL } from "./version.js";
import { ReportStatusSchema } from "./report.js";

/**
 * Fields common to every event. Each line of `events.jsonl` stands on its
 * own: a consumer can read the log from the end with no prior state.
 */
const base = z.object({
  protocol: z.literal(EVENT_PROTOCOL),
  /** Increasing sequence number, scoped to the task. */
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  task_id: z.string(),
});

/**
 * The common vocabulary into which each adapter translates its CLI's JSON
 * stream. It is what makes providers interchangeable as seen from the main
 * agent: a `tool_use` event means the same thing whether it comes from Codex
 * or from Antigravity.
 */
export const EventSchema = z.discriminatedUnion("type", [
  base.extend({
    type: z.literal("started"),
    agent: z.string(),
    /** Command line actually executed, useful for diagnosis. */
    command: z.string().default(""),
  }),
  base.extend({
    type: z.literal("thinking"),
    text: z.string(),
  }),
  base.extend({
    type: z.literal("message"),
    text: z.string(),
  }),
  base.extend({
    type: z.literal("tool_use"),
    tool: z.string(),
    input_summary: z.string().default(""),
    status: z.enum(["started", "succeeded", "failed"]).default("started"),
    /**
     * Identifier of the tool call on the agent's side, when its stream
     * provides one — `item_1` for codex, `write_0` for opencode, `toolu_…`
     * for claude. Used to pair the "started" and the "finished" of one and
     * the same call: without it, you have to reconcile on (name, summary),
     * which conflates two identical executions of the same command.
     *
     * It is sometimes the *only* way: claude announces the end of a tool in
     * a `tool_result` block that carries only `tool_use_id`, never the name
     * of the tool — and `translate` is stateless, by contract. The closing
     * event therefore arrives with an empty `tool` and this identifier alone.
     *
     * Empty default: `events.jsonl` files written before this field remain
     * readable.
     */
    id: z.string().default(""),
  }),
  base.extend({
    type: z.literal("file_changed"),
    path: z.string(),
    action: z.enum(["created", "modified", "deleted", "renamed"]),
  }),
  base.extend({
    type: z.literal("progress"),
    message: z.string(),
    pct: z.number().min(0).max(100).optional(),
  }),
  base.extend({
    type: z.literal("question"),
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()).default([]),
  }),
  base.extend({
    type: z.literal("answer"),
    id: z.string(),
    answer: z.string(),
  }),
  base.extend({
    type: z.literal("error"),
    message: z.string(),
    fatal: z.boolean().default(false),
  }),
  base.extend({
    type: z.literal("finished"),
    status: ReportStatusSchema,
    summary: z.string().default(""),
    exit_code: z.number().int().nullish(),
  }),
]);

export type CaesarEvent = z.infer<typeof EventSchema>;
export type CaesarEventInput = z.input<typeof EventSchema>;
export type CaesarEventType = CaesarEvent["type"];

/** Builds an event, filling in the common fields. */
export function makeEvent<T extends CaesarEventInput["type"]>(
  taskId: string,
  seq: number,
  type: T,
  fields: Omit<Extract<CaesarEventInput, { type: T }>, "protocol" | "seq" | "at" | "task_id" | "type">,
): CaesarEvent {
  return EventSchema.parse({
    protocol: EVENT_PROTOCOL,
    seq,
    at: new Date().toISOString(),
    task_id: taskId,
    type,
    ...fields,
  });
}
