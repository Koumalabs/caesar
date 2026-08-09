import { z } from "zod";
import { EVENT_PROTOCOL } from "./version.js";
import { ReportStatusSchema } from "./report.js";

/**
 * Champs communs à tout événement. Chaque ligne de `events.jsonl` se suffit à
 * elle-même : un consommateur peut lire le journal par la fin sans état préalable.
 */
const base = z.object({
  protocol: z.literal(EVENT_PROTOCOL),
  /** Numéro d'ordre croissant, propre à la tâche. */
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  task_id: z.string(),
});

/**
 * Le vocabulaire commun vers lequel chaque adaptateur traduit le flux JSON de
 * son CLI. C'est ce qui rend les providers interchangeables vus de l'agent
 * principal : un événement `tool_use` a le même sens qu'il vienne de Codex ou
 * d'Antigravity.
 */
export const EventSchema = z.discriminatedUnion("type", [
  base.extend({
    type: z.literal("started"),
    agent: z.string(),
    /** Ligne de commande réellement exécutée, utile au diagnostic. */
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

export type OrchEvent = z.infer<typeof EventSchema>;
export type OrchEventInput = z.input<typeof EventSchema>;
export type OrchEventType = OrchEvent["type"];

/** Construit un événement en remplissant les champs communs. */
export function makeEvent<T extends OrchEventInput["type"]>(
  taskId: string,
  seq: number,
  type: T,
  fields: Omit<Extract<OrchEventInput, { type: T }>, "protocol" | "seq" | "at" | "task_id" | "type">,
): OrchEvent {
  return EventSchema.parse({
    protocol: EVENT_PROTOCOL,
    seq,
    at: new Date().toISOString(),
    task_id: taskId,
    type,
    ...fields,
  });
}
