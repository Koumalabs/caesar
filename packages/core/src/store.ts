/**
 * Persistance de l'état des tâches : un fichier JSON par tâche, sous
 * `<root>/.orch/state/tasks/<id>.json`.
 *
 * L'écriture passe toujours par un fichier temporaire, jamais directement
 * par la cible finale — le serveur MCP et le CLI liront cet état pendant
 * qu'une exécution est en train d'écrire dedans : un lecteur ne doit jamais
 * voir un JSON à moitié écrit. Ce fichier temporaire est ensuite publié de
 * deux façons distinctes selon l'opération : `rename` pour `update`, qui
 * doit toujours remplacer l'existant ; `link` pour `create`, qui ne doit au
 * contraire jamais le faire (voir le commentaire de `create` ci-dessous).
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
   * `raw.log` tronqué et un `events.jsonl` entrelacé. L'exclusivité est
   * garantie par le système de fichiers (publication par `link`, qui échoue
   * si la cible existe déjà), pas seulement par une relecture préalable :
   * deux `create` concurrents sur le même identifiant ne peuvent pas tous
   * les deux réussir. `update` reste la seule façon de modifier un
   * enregistrement existant.
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

  /**
   * Écrit `record` dans un fichier temporaire du même répertoire (même
   * système de fichiers, condition nécessaire pour que `rename`/`link`
   * soient atomiques juste après) : à cet instant, `record` n'est encore
   * visible sous aucun nom que `create`/`update` publieraient ensuite,
   * chacun à sa façon — voir l'en-tête du fichier.
   */
  async function writeTemp(record: TaskRecord): Promise<string> {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${record.id}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    return tmp;
  }

  async function writeRecord(record: TaskRecord): Promise<void> {
    const tmp = await writeTemp(record);
    // `rename` remplace toujours l'existant, sans condition — exactement ce
    // qu'`update` veut : un lecteur concurrent ne voit jamais qu'une version
    // complète (l'ancienne ou la nouvelle), jamais un fichier partiel.
    await rename(tmp, fileFor(record.id));
  }

  return {
    async create(record) {
      const tmp = await writeTemp(record);
      try {
        // `link`, pas `rename` : crée une nouvelle entrée de répertoire vers
        // l'inode du fichier temporaire (déjà intégralement écrit — jamais
        // de lecture partielle possible, même fenêtre de sécurité que
        // `update`) sans jamais toucher une cible qui existerait déjà —
        // échoue avec EEXIST dans ce cas, garanti par le système de
        // fichiers. `rename` n'offre pas cette garantie (il écrase
        // toujours) ; c'est précisément pour ça qu'`update`, qui doit au
        // contraire toujours remplacer, continue de l'utiliser ci-dessus.
        await link(tmp, fileFor(record.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Tâche déjà existante : "${record.id}" (un enregistrement porte déjà cet identifiant ; utilisez update pour le modifier).`);
        }
        throw error;
      } finally {
        // `tmp` ne sert plus une fois publié (link crée un second lien
        // indépendant vers le même contenu) ou abandonné (échec) : jamais
        // laissé derrière, dans un cas comme dans l'autre.
        await unlink(tmp).catch(() => {});
      }
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
