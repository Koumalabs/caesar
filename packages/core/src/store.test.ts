import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTaskStore, type TaskRecord, type TaskStore } from "./store.js";

function sampleRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t_0001",
    agent: "codex",
    objective: "Corriger la régression",
    status: "pending",
    created_at: "2026-08-09T10:00:00.000Z",
    task_dir: "/tmp/task",
    workspace: "/tmp/wt",
    isolation: "worktree",
    mode: "write",
    report_via: "file",
    depth: 0,
    ...overrides,
  };
}

describe("fileTaskStore", () => {
  let root: string;
  let store: TaskStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-store-"));
    store = fileTaskStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("crée puis relit une tâche à l'identique", async () => {
    const record = sampleRecord();
    await store.create(record);
    expect(await store.get(record.id)).toEqual(record);
  });

  it("renvoie null pour une tâche inconnue", async () => {
    expect(await store.get("t_absent")).toBeNull();
  });

  it("refuse de créer deux fois le même identifiant, sans écraser silencieusement", async () => {
    await store.create(sampleRecord({ id: "t_dup", objective: "premier" }));
    await expect(store.create(sampleRecord({ id: "t_dup", objective: "second" }))).rejects.toThrow(/t_dup/);
    // Le premier enregistrement survit, inchangé.
    expect((await store.get("t_dup"))!.objective).toBe("premier");
  });

  it("deux create concurrents sur le même identifiant : un seul gagne, sans écrasement", async () => {
    const id = "t_race";
    const results = await Promise.allSettled([
      store.create(sampleRecord({ id, objective: "premier" })),
      store.create(sampleRecord({ id, objective: "second" })),
    ]);

    // Exactement l'un des deux réussit, l'autre échoue en nommant l'identifiant.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringMatching(/t_race/) });

    // L'enregistrement persisté est celui du gagnant, jamais un mélange des deux.
    const persisted = await store.get(id);
    expect(["premier", "second"]).toContain(persisted!.objective);
  });

  it("écrit sous <root>/.orch/state/tasks/<id>.json", async () => {
    const record = sampleRecord();
    await store.create(record);
    const raw = await readFile(join(root, ".orch", "state", "tasks", "t_0001.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(record);
  });

  it("met à jour un sous-ensemble de champs et renvoie l'enregistrement complet", async () => {
    await store.create(sampleRecord());
    const updated = await store.update("t_0001", { status: "succeeded", exit_code: 0 });
    expect(updated).toEqual(sampleRecord({ status: "succeeded", exit_code: 0 }));
    expect(await store.get("t_0001")).toEqual(updated);
  });

  it("lève sur la mise à jour d'une tâche inconnue", async () => {
    await expect(store.update("t_fantome", { status: "failed" })).rejects.toThrow(/t_fantome/);
  });

  it("liste toutes les tâches sans filtre", async () => {
    await store.create(sampleRecord({ id: "t_1", status: "pending" }));
    await store.create(sampleRecord({ id: "t_2", status: "succeeded" }));
    const ids = (await store.list()).map((r) => r.id).sort();
    expect(ids).toEqual(["t_1", "t_2"]);
  });

  it("liste vide quand aucune tâche n'existe encore", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("filtre par statut", async () => {
    await store.create(sampleRecord({ id: "t_1", status: "pending" }));
    await store.create(sampleRecord({ id: "t_2", status: "succeeded" }));
    await store.create(sampleRecord({ id: "t_3", status: "failed" }));
    const ids = (await store.list({ status: ["succeeded", "failed"] })).map((r) => r.id).sort();
    expect(ids).toEqual(["t_2", "t_3"]);
  });

  it("écrit de façon atomique : aucune lecture concurrente ne voit un JSON tronqué", async () => {
    const id = "t_atomic";
    // Un contenu volumineux pour donner à l'écriture une durée non nulle.
    const padding = "x".repeat(200_000);
    await store.create(sampleRecord({ id, objective: padding }));

    let sawTruncated = false;
    let sawComplete = false;
    const path = join(root, ".orch", "state", "tasks", `${id}.json`);

    const readerLoop = (async () => {
      for (let i = 0; i < 50; i++) {
        try {
          const raw = await readFile(path, "utf8");
          JSON.parse(raw);
          sawComplete = true;
        } catch {
          sawTruncated = true;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const writerLoop = (async () => {
      for (let i = 0; i < 50; i++) {
        await store.update(id, { objective: padding + i });
      }
    })();

    await Promise.all([readerLoop, writerLoop]);
    expect(sawComplete).toBe(true);
    expect(sawTruncated).toBe(false);
  });

  it("persiste et relit les champs d'application (applied_at, applied_patch_digest)", async () => {
    const record: TaskRecord = {
      id: "t_applique",
      agent: "codex",
      objective: "persister les champs d'application",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      task_dir: join(root, ".orch", "tasks", "t_applique"),
      workspace: join(root, "ws"),
      isolation: "worktree",
      mode: "write",
      report_via: "file",
      depth: 0,
    };
    await store.create(record);
    await store.update("t_applique", {
      applied_at: "2026-08-12T10:00:00.000Z",
      applied_patch_digest: "a".repeat(64),
    });

    const relu = await store.get("t_applique");
    expect(relu?.applied_at).toBe("2026-08-12T10:00:00.000Z");
    expect(relu?.applied_patch_digest).toBe("a".repeat(64));
  });

  /**
   * I9 de la revue finale : vérifié à l'époque en exécutant le code compilé
   * (`store.get("../../../secret")` rendait le contenu d'un fichier
   * arbitraire hors du store). Reproduit ici littéralement, plus le second
   * geste du même correctif (validation de forme au lieu d'un cast).
   */
  describe("I9 — traversée de chemin sur task_id", () => {
    it("get/update/create rejettent un identifiant contenant un séparateur de chemin, sans jamais sortir de dir", async () => {
      // Dépose "le secret" juste à côté de dir (donc atteignable par ../../../secret
      // depuis un id mal validé), pour prouver qu'il n'est jamais lu.
      const secretPath = join(root, "secret.json");
      await writeFile(secretPath, JSON.stringify({ status: "top-secret-value", pid: 999999 }), "utf8");

      const traversal = "../secret";
      await expect(store.get(traversal)).resolves.toBeNull();
      // `update` lit d'abord l'enregistrement existant (`readRecord`, qui
      // avale l'erreur de validation en `null`, comme n'importe quel id
      // inconnu) : le refus prend donc la forme "Tâche inconnue", pas
      // "invalide" — les deux ferment la traversée, aucune ne l'atteint.
      await expect(store.update(traversal, { status: "cancelled" })).rejects.toThrow(/inconnue/);
      // `create` valide directement (`writeTemp`), sans passer par cette lecture.
      await expect(store.create(sampleRecord({ id: traversal }))).rejects.toThrow(/invalide/);

      // Le "secret" existe toujours, intact : aucune des trois opérations n'y a touché.
      expect(JSON.parse(await readFile(secretPath, "utf8"))).toEqual({ status: "top-secret-value", pid: 999999 });
    });

    it("un identifiant lisible sans séparateur (usage documenté de RunTaskInput.taskId) reste accepté", async () => {
      const record = sampleRecord({ id: "t_imposed-readable-id" });
      await store.create(record);
      expect(await store.get("t_imposed-readable-id")).toEqual(record);
    });

    it("un fichier du store dont le contenu n'est pas un TaskRecord valide est ignoré plutôt qu'interprété tel quel (schéma, pas un cast)", async () => {
      const tasksDir = join(root, ".orch", "state", "tasks");
      await mkdir(tasksDir, { recursive: true });
      // Un JSON syntaxiquement valide, mais dont la forme ne correspond à
      // aucun TaskRecord (status hors énumération, pid non numérique) :
      // avant le schéma zod, `JSON.parse(...) as TaskRecord` l'aurait rendu
      // tel quel, "status" et "pid" compris — c'est précisément ce que
      // `orch_cancel` utiliserait pour signaler un pid arbitraire.
      await writeFile(
        join(tasksDir, "t_malformed.json"),
        JSON.stringify({ status: "top-secret-value", pid: "pas-un-pid" }),
        "utf8",
      );
      expect(await store.get("t_malformed")).toBeNull();
      expect(await store.list()).toEqual([]);
    });
  });
});
