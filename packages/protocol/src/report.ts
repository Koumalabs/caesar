import { z } from "zod";
import { REPORT_PROTOCOL } from "./version.js";

export const ReportStatusSchema = z.enum([
  /** Objective met, acceptance criteria satisfied. */
  "success",
  /** Part of the work is done, the rest is described in next_steps. */
  "partial",
  /** The agent failed and has no way out. */
  "failed",
  /** The agent is stopped by a decision that is not its to make: see questions. */
  "blocked",
]);

export const ChangeSchema = z.object({
  path: z.string(),
  action: z.enum(["created", "modified", "deleted", "renamed"]),
  summary: z.string().default(""),
});

export const CommandRunSchema = z.object({
  command: z.string(),
  exit_code: z.number().int().nullish(),
  note: z.string().default(""),
});

export const FindingSchema = z.object({
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  title: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  detail: z.string().default(""),
});

export const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).default([]),
});

export const ArtifactSchema = z.object({
  path: z.string(),
  description: z.string().default(""),
});

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});

/**
 * A sub-agent's report.
 *
 * Only `protocol`, `status` and `summary` are required: a standard that is too
 * strict would not be adopted by outside agents. Everything else carries a
 * default value, so that a minimal report remains valid.
 *
 * `changes` is declarative: the orchestrator systematically reconciles it
 * with the worktree's git diff, which alone is the source of truth.
 */
export const ReportSchema = z.object({
  protocol: z.literal(REPORT_PROTOCOL),
  task_id: z.string().default(""),
  status: ReportStatusSchema,
  /** Two or three sentences: what was done, and what remains open. */
  summary: z.string().min(1),
  details: z.string().default(""),
  changes: z.array(ChangeSchema).default([]),
  commands_run: z.array(CommandRunSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
  next_steps: z.array(z.string()).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  usage: UsageSchema.optional(),
});

export type ReportStatus = z.infer<typeof ReportStatusSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type ReportInput = z.input<typeof ReportSchema>;
