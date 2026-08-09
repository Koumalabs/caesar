import { z } from "zod";
import { REPORT_PROTOCOL } from "./version.js";

export const ReportStatusSchema = z.enum([
  /** Objectif atteint, critères d'acceptation remplis. */
  "success",
  /** Une partie du travail est faite, le reste est décrit dans next_steps. */
  "partial",
  /** L'agent a échoué et n'a pas de chemin de sortie. */
  "failed",
  /** L'agent est arrêté par une décision qui ne lui appartient pas : voir questions. */
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
 * Le compte rendu d'un sous-agent.
 *
 * Seuls `protocol`, `status` et `summary` sont exigés : un standard trop strict
 * ne serait pas adopté par les agents extérieurs. Tout le reste porte une valeur
 * par défaut, de sorte qu'un rapport minimal reste valide.
 *
 * `changes` relève de la déclaration : l'orchestrateur la recoupe systématiquement
 * avec le diff git du worktree, qui seul fait foi.
 */
export const ReportSchema = z.object({
  protocol: z.literal(REPORT_PROTOCOL),
  task_id: z.string().default(""),
  status: ReportStatusSchema,
  /** Deux ou trois phrases : ce qui a été fait, et ce qui reste ouvert. */
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
