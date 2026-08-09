import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
