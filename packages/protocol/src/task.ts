import { z } from "zod";
import { TASK_PROTOCOL } from "./version.js";

/**
 * Coordonnées du canal retour. Quand il est présent, l'agent peut dialoguer avec
 * l'orchestrateur en cours de route plutôt que de se contenter d'un rapport final.
 */
export const ChannelSchema = z.object({
  transport: z.literal("mcp-stdio"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Nom sous lequel le serveur est déclaré côté agent. */
  server_name: z.string().default("orch"),
});

export const TaskModeSchema = z.enum(["read-only", "write"]);
export const IsolationSchema = z.enum(["inplace", "worktree"]);

/**
 * La mission confiée à un sous-agent. Écrite par l'orchestrateur dans
 * `task.json`, elle constitue la seule entrée dont un agent a besoin.
 */
export const TaskSchema = z.object({
  protocol: z.literal(TASK_PROTOCOL),
  id: z.string(),
  created_at: z.iso.datetime(),

  /** Rôle demandé, quand la délégation passe par un profil plutôt qu'un agent nommé. */
  role: z.string().optional(),
  /** Agent effectivement retenu pour l'exécution. */
  agent: z.string(),

  /** L'objectif, en une phrase. C'est le champ que lira un humain pressé. */
  objective: z.string().min(1),
  /** Contexte long : extraits de code, historique, liens. */
  context: z.string().default(""),
  /** Interdits et obligations explicites. */
  constraints: z.array(z.string()).default([]),
  /** Ce qui permettra de juger la tâche réussie. */
  acceptance_criteria: z.array(z.string()).default([]),

  mode: TaskModeSchema,
  isolation: IsolationSchema,
  /** Racine de travail de l'agent, en chemin absolu. */
  workspace: z.string(),
  /** Référence git de départ, renseignée en isolation worktree. */
  base_ref: z.string().optional(),

  /** Budget de temps, en millisecondes. */
  deadline_ms: z.number().int().positive(),
  /** Profondeur de délégation : 0 pour l'agent principal. */
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
