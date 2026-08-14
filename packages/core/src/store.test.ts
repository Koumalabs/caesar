import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTaskStore, type TaskRecord, type TaskStore } from "./store.js";

function sampleRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t_0001",
    agent: "codex",
    objective: "Fix the regression",
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
    root = await mkdtemp(join(tmpdir(), "caesar-store-"));
    store = fileTaskStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates then re-reads a task identically", async () => {
    const record = sampleRecord();
    await store.create(record);
    expect(await store.get(record.id)).toEqual(record);
  });

  it("returns null for an unknown task", async () => {
    expect(await store.get("t_absent")).toBeNull();
  });

  it("refuses to create the same identifier twice, without silently overwriting", async () => {
    await store.create(sampleRecord({ id: "t_dup", objective: "first" }));
    await expect(store.create(sampleRecord({ id: "t_dup", objective: "second" }))).rejects.toThrow(/t_dup/);
    // The first record survives, unchanged.
    expect((await store.get("t_dup"))!.objective).toBe("first");
  });

  it("two concurrent creates on the same identifier: only one wins, no overwrite", async () => {
    const id = "t_race";
    const results = await Promise.allSettled([
      store.create(sampleRecord({ id, objective: "first" })),
      store.create(sampleRecord({ id, objective: "second" })),
    ]);

    // Exactly one of the two succeeds, the other fails naming the identifier.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringMatching(/t_race/) });

    // The persisted record is the winner's, never a mixture of the two.
    const persisted = await store.get(id);
    expect(["first", "second"]).toContain(persisted!.objective);
  });

  it("writes under <root>/.caesar/state/tasks/<id>.json", async () => {
    const record = sampleRecord();
    await store.create(record);
    const raw = await readFile(join(root, ".caesar", "state", "tasks", "t_0001.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(record);
  });

  it("updates a subset of fields and returns the complete record", async () => {
    await store.create(sampleRecord());
    const updated = await store.update("t_0001", { status: "succeeded", exit_code: 0 });
    expect(updated).toEqual(sampleRecord({ status: "succeeded", exit_code: 0 }));
    expect(await store.get("t_0001")).toEqual(updated);
  });

  it("throws on updating an unknown task", async () => {
    await expect(store.update("t_ghost", { status: "failed" })).rejects.toThrow(/t_ghost/);
  });

  it("lists all tasks without a filter", async () => {
    await store.create(sampleRecord({ id: "t_1", status: "pending" }));
    await store.create(sampleRecord({ id: "t_2", status: "succeeded" }));
    const ids = (await store.list()).map((r) => r.id).sort();
    expect(ids).toEqual(["t_1", "t_2"]);
  });

  it("empty list when no task exists yet", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("filters by status", async () => {
    await store.create(sampleRecord({ id: "t_1", status: "pending" }));
    await store.create(sampleRecord({ id: "t_2", status: "succeeded" }));
    await store.create(sampleRecord({ id: "t_3", status: "failed" }));
    const ids = (await store.list({ status: ["succeeded", "failed"] })).map((r) => r.id).sort();
    expect(ids).toEqual(["t_2", "t_3"]);
  });

  it("writes atomically: no concurrent read ever sees a truncated JSON", async () => {
    const id = "t_atomic";
    // A large content to give the write a non-zero duration.
    const padding = "x".repeat(200_000);
    await store.create(sampleRecord({ id, objective: padding }));

    let sawTruncated = false;
    let sawComplete = false;
    const path = join(root, ".caesar", "state", "tasks", `${id}.json`);

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

  it("persists and re-reads the apply fields (applied_at, applied_patch_digest)", async () => {
    const record: TaskRecord = {
      id: "t_applied",
      agent: "codex",
      objective: "persist the apply fields",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      task_dir: join(root, ".caesar", "tasks", "t_applied"),
      workspace: join(root, "ws"),
      isolation: "worktree",
      mode: "write",
      report_via: "file",
      depth: 0,
    };
    await store.create(record);
    await store.update("t_applied", {
      applied_at: "2026-08-12T10:00:00.000Z",
      applied_patch_digest: "a".repeat(64),
    });

    const reread = await store.get("t_applied");
    expect(reread?.applied_at).toBe("2026-08-12T10:00:00.000Z");
    expect(reread?.applied_patch_digest).toBe("a".repeat(64));
  });

  /**
   * I9 of the final review: verified at the time by running the compiled
   * code (`store.get("../../../secret")` returned the content of an
   * arbitrary file outside the store). Reproduced here literally, plus the
   * second move of the same fix (shape validation instead of a cast).
   */
  describe("I9 — path traversal on task_id", () => {
    it("get/update/create reject an identifier containing a path separator, without ever leaving dir", async () => {
      // Drops "the secret" right next to dir (hence reachable via ../../../secret
      // from a badly validated id), to prove it is never read.
      const secretPath = join(root, "secret.json");
      await writeFile(secretPath, JSON.stringify({ status: "top-secret-value", pid: 999999 }), "utf8");

      const traversal = "../secret";
      await expect(store.get(traversal)).resolves.toBeNull();
      // `update` first reads the existing record (`readRecord`, which
      // swallows the validation error into `null`, like any unknown
      // id): the refusal therefore takes the form "Unknown task", not
      // "invalid" — both close the traversal, neither reaches it.
      await expect(store.update(traversal, { status: "cancelled" })).rejects.toThrow(/Unknown/);
      // `create` validates directly (`writeTemp`), without going through that read.
      await expect(store.create(sampleRecord({ id: traversal }))).rejects.toThrow(/Invalid/);

      // The "secret" still exists, intact: none of the three operations touched it.
      expect(JSON.parse(await readFile(secretPath, "utf8"))).toEqual({ status: "top-secret-value", pid: 999999 });
    });

    it("a readable identifier without a separator (documented use of RunTaskInput.taskId) remains accepted", async () => {
      const record = sampleRecord({ id: "t_imposed-readable-id" });
      await store.create(record);
      expect(await store.get("t_imposed-readable-id")).toEqual(record);
    });

    it("a store file whose content is not a valid TaskRecord is ignored rather than interpreted as-is (schema, not a cast)", async () => {
      const tasksDir = join(root, ".caesar", "state", "tasks");
      await mkdir(tasksDir, { recursive: true });
      // A syntactically valid JSON, but whose shape matches no
      // TaskRecord (status outside the enumeration, non-numeric pid):
      // before the zod schema, `JSON.parse(...) as TaskRecord` would have
      // returned it as-is, "status" and "pid" included — precisely what
      // `caesar_cancel` would use to signal an arbitrary pid.
      await writeFile(
        join(tasksDir, "t_malformed.json"),
        JSON.stringify({ status: "top-secret-value", pid: "not-a-pid" }),
        "utf8",
      );
      expect(await store.get("t_malformed")).toBeNull();
      expect(await store.list()).toEqual([]);
    });
  });
});
