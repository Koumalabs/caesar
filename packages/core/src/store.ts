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
import { z } from "zod";
import { IsolationSchema, ReportStatusSchema, TaskModeSchema } from "@orch/protocol";
import type { Isolation, ReportChannel, ReportStatus, TaskMode } from "@orch/protocol";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

/** Provenance du rapport finalement retenu, du plus fiable au plus dégradé. */
export type ReportSource = "channel" | "schema" | "file" | "extracted" | "synthesized";

/**
 * Provenance de `report.changes` — voir C2 de la revue finale : "git" quand
 * l'orchestrateur a pu recouper la déclaration de l'agent avec l'état git
 * constaté du workspace (isolation `worktree`, ou `inplace` dans un dépôt
 * git), "declaration" quand aucun recoupement n'était possible (workspace
 * hors dépôt git) — dans ce seul cas, `changes` reste la parole de l'agent,
 * jamais présentée comme davantage.
 */
export type ChangesVerifiedBy = "git" | "declaration";

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
  /**
   * Chemins que l'orchestrateur a posés dans le worktree (`[worktree]
   * copy`/`link`), à retirer du diff — voir `WorktreeHandle.excluded`.
   *
   * Persisté ici parce que `orch diff` et `orch apply` recalculent le diff
   * longtemps après la fin de la tâche, à partir du seul enregistrement : sans
   * cette trace, un `.env` recopié redeviendrait applicable au dépôt
   * principal. Absent pour toute tâche antérieure à `[worktree]`, ou sans
   * matérialisation — le schéma n'est pas `.strict()`, l'ajout est
   * rétrocompatible dans les deux sens.
   */
  excluded_paths?: string[];
  exit_code?: number | null;
  report_via: ReportChannel;
  report_source?: ReportSource;
  changes_verified_by?: ChangesVerifiedBy;
  /**
   * Le `status` du rapport résolu (`report.ts`), distinct de `status`
   * ci-dessus — voir I3 de la revue finale : `status` ne reflète que
   * l'issue du *processus* (code de sortie, timeout, annulation), jamais ce
   * que l'agent a déclaré dans son rapport. Un agent qui écrit
   * `{"status":"failed"}` puis sort en code 0 produit `status: "succeeded"`
   * et `report_status: "failed"` — les deux sont vrais, à des niveaux
   * différents ; ni `orch ps`, ni le code de sortie de `orch run`, ni
   * `orch_status` ne doivent en ignorer un des deux.
   */
  report_status?: ReportStatus;
  depth: number;
  /**
   * Identifiant du processus du sous-agent, le temps qu'il tourne. Renseigné
   * par le moteur au lancement, effacé à la fin (voir `runner.ts`) : c'est ce
   * qui permet à `orch cancel` (tâche CLI) d'envoyer SIGTERM à une tâche
   * lancée par un autre processus (le serveur MCP, par exemple) sans autre
   * moyen de retrouver son PID.
   */
  pid?: number;
  /**
   * Posés par `applyRecordedWorktree` (engine/worktree.ts) quand le diff du
   * worktree a été appliqué au dépôt principal : l'instant de l'application,
   * et le sha256 (hex) du texte du patch appliqué. Un nouvel apply réussi
   * les écrase — c'est la dernière application qui fait foi. `orch gc` s'en
   * sert pour collecter un worktree dont le patch courant porte encore la
   * même empreinte : un fait daté et positif, jamais une déduction depuis le
   * contenu. Absents pour toute tâche jamais appliquée, appliquée à vide, ou
   * antérieure à ce mécanisme — le schéma n'étant pas `.strict()`, l'ajout
   * est rétrocompatible dans les deux sens.
   */
  applied_at?: string;
  applied_patch_digest?: string;
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

/**
 * Rejette tout `id` qui pourrait s'échapper de `dir` une fois composé dans
 * un chemin de fichier — voir I9 de la revue finale, vérifié en exécutant
 * le code : `fileFor` faisait `join(dir, \`${id}.json\`)` sans normalisation
 * ni validation, et `store.get("../../../secret")` rendait le contenu d'un
 * fichier arbitraire hors du store (`{"status":"top-secret-value",...}`).
 * `task_id` est déclaré `z.string().min(1)` dans sept tools MCP pilotés par
 * le modèle (`orch_logs`/`orch_status`/`orch_diff`/`orch_apply`/
 * `orch_cancel`/`orch_await`/`orch_answer`) : ce garde, unique et placé ici
 * plutôt que répété dans chacun, ferme la catégorie entière d'un geste.
 *
 * N'impose pas le format généré par `generateTaskId` (`t_` + 32 hex) : des
 * identifiants lisibles ("t_imposed", "t_test"…) sont un usage légitime et
 * testé de `RunTaskInput.taskId`, documenté comme personnalisable par
 * l'appelant. Seuls les séparateurs de chemin, les octets nuls et les noms
 * de répertoire spéciaux (".", "..") sont interdits.
 */
function assertSafeTaskId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error(`Identifiant de tâche invalide : "${id}".`);
  }
}

/**
 * Valide la forme d'un enregistrement relu depuis le disque, plutôt qu'un
 * cast `as TaskRecord` — second geste d'I9 de la revue finale : sans lui,
 * un fichier `.json` du store dont le contenu ne serait pas un vrai
 * `TaskRecord` (corruption, écriture partielle échappée à l'atomicité
 * habituelle, fichier déposé par autre chose) serait néanmoins interprété
 * comme tel — notamment son `status`/`pid`, que `orch_cancel` utilise pour
 * envoyer un signal à un processus (`cancel.ts`, repli par pid).
 */
const TaskRecordSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  role: z.string().optional(),
  objective: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  created_at: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  task_dir: z.string(),
  workspace: z.string(),
  isolation: IsolationSchema,
  mode: TaskModeSchema,
  branch: z.string().optional(),
  excluded_paths: z.array(z.string()).optional(),
  exit_code: z.number().int().nullish(),
  report_via: z.enum(["channel", "schema", "file"]),
  report_source: z.enum(["channel", "schema", "file", "extracted", "synthesized"]).optional(),
  changes_verified_by: z.enum(["git", "declaration"]).optional(),
  report_status: ReportStatusSchema.optional(),
  depth: z.number().int().nonnegative(),
  pid: z.number().int().positive().optional(),
  applied_at: z.string().optional(),
  applied_patch_digest: z.string().optional(),
});

export function fileTaskStore(root: string): TaskStore {
  const dir = join(root, ".orch", "state", "tasks");

  function fileFor(id: string): string {
    assertSafeTaskId(id);
    return join(dir, `${id}${SUFFIX}`);
  }

  async function readRecord(id: string): Promise<TaskRecord | null> {
    try {
      const raw = await readFile(fileFor(id), "utf8");
      const parsed = TaskRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as TaskRecord) : null;
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
    // Construit son propre chemin à partir de `record.id`, sans passer par
    // `fileFor` : validé ici séparément pour ne pas dépendre de l'ordre
    // d'appel avec `fileFor` plus bas.
    assertSafeTaskId(record.id);
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
