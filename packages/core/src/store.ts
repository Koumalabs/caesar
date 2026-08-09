/**
 * Persistance de l'état des tâches : un fichier JSON par tâche, sous
 * `<root>/.orch/state/tasks/<id>.json`.
 *
 * L'écriture est atomique — fichier temporaire puis `rename` — parce que le
 * serveur MCP et le CLI (tâches à venir) liront cet état pendant qu'une
 * exécution est en train d'écrire dedans : un lecteur ne doit jamais voir un
 * JSON à moitié écrit.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Isolation, ReportChannel, TaskMode } from "@orch/protocol";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

/** Provenance du rapport finalement retenu, du plus fiable au plus dégradé. */
export type ReportSource = "channel" | "schema" | "file" | "extracted" | "synthesized";

export interface TaskRecord {
  id: string;
  agent: string;
  role?: string;
  objective: string;
  status: TaskStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_dir: string;
  workspace: string;
  isolation: Isolation;
  mode: TaskMode;
  branch?: string;
  exit_code?: number | null;
  report_via: ReportChannel;
  report_source?: ReportSource;
  depth: number;
  /**
   * Identifiant du processus du sous-agent, le temps qu'il tourne. Renseigné
   * par le moteur au lancement, effacé à la fin (voir `runner.ts`) : c'est ce
   * qui permet à `orch cancel` (tâche CLI) d'envoyer SIGTERM à une tâche
   * lancée par un autre processus (le serveur MCP, par exemple) sans autre
   * moyen de retrouver son PID.
   */
  pid?: number;
}

export interface TaskStore {
  /**
   * Crée l'enregistrement d'une nouvelle tâche. Lève si `record.id` est déjà
   * pris — jamais un écrasement silencieux : deux exécutions qui partageraient
   * le même identifiant (bug d'un appelant, `taskId` imposé et réutilisé par
   * erreur) écriraient sinon dans le même répertoire de tâche, avec un
   * `raw.log` tronqué et un `events.jsonl` entrelacé. `update` reste la seule
   * façon de modifier un enregistrement existant.
   */
  create(record: TaskRecord): Promise<void>;
  update(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | null>;
  list(filter?: { status?: TaskStatus[] }): Promise<TaskRecord[]>;
}

const SUFFIX = ".json";

export function fileTaskStore(root: string): TaskStore {
  const dir = join(root, ".orch", "state", "tasks");

  function fileFor(id: string): string {
    return join(dir, `${id}${SUFFIX}`);
  }

  async function readRecord(id: string): Promise<TaskRecord | null> {
    try {
      const raw = await readFile(fileFor(id), "utf8");
      return JSON.parse(raw) as TaskRecord;
    } catch {
      return null;
    }
  }

  async function writeRecord(record: TaskRecord): Promise<void> {
    await mkdir(dir, { recursive: true });
    const target = fileFor(record.id);
    // Fichier temporaire dans le même répertoire (même système de fichiers,
    // condition nécessaire pour que `rename` soit atomique), suivi d'un
    // renommage : un lecteur concurrent ne voit jamais un fichier partiel.
    const tmp = join(dir, `.${record.id}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  }

  return {
    async create(record) {
      const existing = await readRecord(record.id);
      if (existing) {
        throw new Error(`Tâche déjà existante : "${record.id}" (un enregistrement porte déjà cet identifiant ; utilisez update pour le modifier).`);
      }
      await writeRecord(record);
    },

    async update(id, patch) {
      const current = await readRecord(id);
      if (!current) {
        throw new Error(`Tâche inconnue : "${id}"`);
      }
      const updated: TaskRecord = { ...current, ...patch };
      await writeRecord(updated);
      return updated;
    },

    get: (id) => readRecord(id),

    async list(filter) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      const ids = entries
        .filter((entry) => entry.endsWith(SUFFIX) && !entry.startsWith("."))
        .map((entry) => entry.slice(0, -SUFFIX.length));
      const records = await Promise.all(ids.map((id) => readRecord(id)));
      const found = records.filter((record): record is TaskRecord => record !== null);
      return filter?.status ? found.filter((record) => filter.status!.includes(record.status)) : found;
    },
  };
}
