# apply → gc cycle: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orch apply` writes the fact of the application into the task's record, `orch gc` collects worktrees that were applied and unchanged since, and the deposited assets say how to invoke the binary and close the cycle.

**Architecture:** a single helper in `@orch/core` (`applyRecordedWorktree`) replaces `applyWorktree` as the only application path and sets `applied_at` + `applied_patch_digest` (sha256 of the patch) on the `TaskRecord`; `garbageCollectWorktrees` reloads the real handle, recomputes the patch with the same `diffWorktree`, and removes on a matching digest (new reason `applied`). The two facades (CLI, MCP) reduce to the helper. This repository's asset sources are edited then resynchronized into the generated catalog.

**Tech stack:** pnpm + TypeScript monorepo (Node 24), zod, vitest, git. Spec: `docs/superpowers/specs/2026-08-12-apply-gc-cycle-design.md`.

## Global Constraints

- Code comments and docstrings: in **French**, dense in "why", like the rest of the repo at the time.
- Asset content (`.claude/skills/orch/**`): in **English** (the language of the existing assets).
- Commit messages: in French, repo style ("Pose…", "Fait…", present-tense verb), ended with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `packages/core/src/agent-assets.generated.ts` is **never** edited by hand: `pnpm run assets:sync` regenerates it. Do not run `orch init` in this repository while editing the asset sources (it would overwrite unsynchronized edits).
- The store's zod schemas are not `.strict()`: any field addition is optional and backward/forward compatible.
- Tests: `pnpm vitest run <path>` from the repository root. Build: `pnpm build` (tsc -b). Never commit `dist/` or `dist-bin/`.
- Every task of the plan ends with a commit that mixes in nothing else.

---

### Task 1: `applied_at` and `applied_patch_digest` fields on `TaskRecord`

**Files:**
- Modify: `packages/core/src/store.ts` (interface `TaskRecord` ~line 85, schema `TaskRecordSchema` ~line 161)
- Test: `packages/core/src/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TaskRecord.applied_at?: string` (ISO) and `TaskRecord.applied_patch_digest?: string` (sha256 hex, 64 characters) — written by Task 2, read by Task 3.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/store.test.ts`, inside the existing `describe("fileTaskStore")` (reuse the `root` variable set up by its `beforeEach`; take the file's first `create`/`get` test as the model for the record's shape):

```ts
it("persists and re-reads the application fields (applied_at, applied_patch_digest)", async () => {
  const store = fileTaskStore(root);
  const record: TaskRecord = {
    id: "t_applique",
    agent: "codex",
    objective: "persist the application fields",
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
```

- [ ] **Step 2: Verify the failure**

Run: `pnpm vitest run packages/core/src/store.test.ts`
Expected: FAIL — TypeScript error (`applied_at` does not exist on `Partial<TaskRecord>`), or `relu?.applied_at` is `undefined` (does the re-read schema drop the unknown field? no: without `.strict()` zod lets it through — the expected failure is therefore the type error at test compilation).

- [ ] **Step 3: Implement**

In `packages/core/src/store.ts`, at the end of the `TaskRecord` interface (after `pid?: number;`):

```ts
  /**
   * Set by `applyRecordedWorktree` (engine/worktree.ts) when the worktree's
   * diff has been applied to the main repository: the instant of the
   * application, and the sha256 (hex) of the applied patch's text. A new
   * successful apply overwrites them — the last application is the one that
   * counts. `orch gc` uses them to collect a worktree whose current patch
   * still carries the same digest: a dated, positive fact, never a deduction
   * from content. Absent for any task never applied, applied while empty, or
   * predating this mechanism — the schema not being `.strict()`, the
   * addition is backward and forward compatible.
   */
  applied_at?: string;
  applied_patch_digest?: string;
```

In `TaskRecordSchema`, after `pid: z.number().int().positive().optional(),`:

```ts
  applied_at: z.string().optional(),
  applied_patch_digest: z.string().optional(),
```

- [ ] **Step 4: Verify the pass**

Run: `pnpm vitest run packages/core/src/store.test.ts`
Expected: PASS (every test in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store.ts packages/core/src/store.test.ts
git commit -m "Donne au store la mémoire d'une application : applied_at + empreinte

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `applyRecordedWorktree`, the only application path (core)

**Files:**
- Modify: `packages/core/src/engine/worktree.ts` (replaces `applyWorktree`, ~lines 344-376)
- Test: `packages/core/src/engine/worktree.test.ts`

**Interfaces:**
- Consumes: `TaskRecord.applied_at`/`applied_patch_digest` (Task 1), existing `loadWorktreeHandle(record)`, `diffWorktree(handle)`, `TaskStore.update`.
- Produces (used by Tasks 3, 4):

```ts
export function patchDigest(patch: string): string; // sha256 hex of the patch's text
export type RecordedApplyOutcome = "applied" | "conflicts" | "no_worktree";
export interface RecordedApplyResult {
  outcome: RecordedApplyOutcome;
  conflicts: string[];
  isEmpty: boolean; // true when there was nothing to apply: nothing is recorded
}
export function applyRecordedWorktree(root: string, store: TaskStore, record: TaskRecord): Promise<RecordedApplyResult>;
```

`applyWorktree` **disappears** (its only two callers, the CLI and MCP facades, migrate in Task 4 — between the two tasks, the root build is broken: this is expected, do not "repair" it by reintroducing it; chain Task 4 before any global `pnpm build`).

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/engine/worktree.test.ts`, add a self-contained `describe`. Reuse the file's local helpers if they exist (`initRepo`, `git`); otherwise copy them from `packages/core/src/engine/gc.test.ts` (lines 21-33). Imports to add: `applyRecordedWorktree`, `createWorktree`, `diffWorktree`, `loadWorktreeHandle`, `patchDigest` from `./worktree.js`; `fileTaskStore` and the `TaskRecord` type from `../store.js`; `TASK_PROTOCOL`, `TaskSchema`, `taskPaths`, `writeTask` from `@orch/protocol`; `mkdtemp`, `readFile`, `rm`, `writeFile` from `node:fs/promises`.

```ts
describe("applyRecordedWorktree", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-apply-record-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A recorded worktree task, with the task.json that loadWorktreeHandle will re-read. */
  async function recordedTask(id: string): Promise<TaskRecord> {
    const handle = await createWorktree(root, id);
    const record: TaskRecord = {
      id,
      agent: "codex",
      objective: "apply and record",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      ended_at: "2026-08-12T09:01:00.000Z",
      task_dir: join(root, ".orch", "tasks", id),
      workspace: handle.path,
      isolation: "worktree",
      mode: "write",
      branch: handle.branch,
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);
    const paths = taskPaths(record.task_dir);
    await writeTask(paths, TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id,
      created_at: record.created_at,
      agent: record.agent,
      objective: record.objective,
      mode: "write",
      isolation: "worktree",
      workspace: handle.path,
      base_ref: handle.baseRef,
      deadline_ms: 60_000,
      report_path: paths.reportPath,
      events_path: paths.eventsPath,
    }));
    return record;
  }

  it("applies the patch and writes applied_at + digest into the record", async () => {
    const record = await recordedTask("t_enregistre");
    await writeFile(join(record.workspace, "b.txt"), "work\n", "utf8");

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "applied", conflicts: [], isEmpty: false });
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("work\n");
    const relu = await fileTaskStore(root).get(record.id);
    expect(relu?.applied_at).toBeDefined();
    const handle = await loadWorktreeHandle(relu!);
    expect(relu?.applied_patch_digest).toBe(patchDigest((await diffWorktree(handle!)).patch));
  });

  it("empty diff: outcome applied but nothing applied, nothing recorded", async () => {
    const record = await recordedTask("t_vide");

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "applied", conflicts: [], isEmpty: true });
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });

  it("conflict: files named, nothing recorded", async () => {
    const record = await recordedTask("t_conflit");
    await writeFile(join(record.workspace, "a.txt"), "worktree version\n", "utf8");
    await writeFile(join(root, "a.txt"), "divergent workspace version\n", "utf8");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-q", "-m", "divergence"]);

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result.outcome).toBe("conflicts");
    expect(result.conflicts).toContain("a.txt");
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });

  it("task without a worktree (inplace): no_worktree, nothing recorded", async () => {
    const record: TaskRecord = {
      id: "t_inplace",
      agent: "codex",
      objective: "in-place task",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      task_dir: join(root, ".orch", "tasks", "t_inplace"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "no_worktree", conflicts: [], isEmpty: true });
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify the failure**

Run: `pnpm vitest run packages/core/src/engine/worktree.test.ts`
Expected: FAIL — `applyRecordedWorktree` and `patchDigest` are not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/engine/worktree.ts`:

1. Add to the imports: `import { createHash } from "node:crypto";` and complete the existing store import: `import type { TaskRecord, TaskStore } from "../store.js";`.

2. Just above the current `applyWorktree`, add:

```ts
/**
 * sha256 (hex) digest of a patch's text — computed in the same place for
 * both sides that must compare it: at application time (below) and in the
 * garbage collector (`gc.ts`), which recomputes the patch with the same
 * `diffWorktree` to decide whether the worktree has moved since.
 */
export function patchDigest(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

export type RecordedApplyOutcome = "applied" | "conflicts" | "no_worktree";

export interface RecordedApplyResult {
  outcome: RecordedApplyOutcome;
  conflicts: string[];
  /** True when there was nothing to apply (no worktree, or empty diff): nothing is recorded. */
  isEmpty: boolean;
}

/**
 * The only application path: diffs the worktree, applies the patch to the
 * main repository, then writes the fact into the task's record —
 * `applied_at` and the digest of the applied patch. Nothing is written on an
 * empty diff or on a conflict: the record only bears witness to an
 * application that actually happened, and a new successful apply overwrites
 * it (the last application counts). Without this trace, `orch gc` could not
 * distinguish an integrated worktree from a worktree carrying unique work:
 * it refused both, even after a perfectly disciplined cycle (observed on two
 * tasks of the `support` project, 2026-08-12).
 */
export async function applyRecordedWorktree(root: string, store: TaskStore, record: TaskRecord): Promise<RecordedApplyResult> {
  const handle = await loadWorktreeHandle(record);
  if (!handle) return { outcome: "no_worktree", conflicts: [], isEmpty: true };

  const diff = await diffWorktree(handle);
  if (diff.isEmpty) return { outcome: "applied", conflicts: [], isEmpty: true };

  const result = await applyPatch(root, diff.patch);
  if (!result.applied) return { outcome: "conflicts", conflicts: result.conflicts, isEmpty: false };

  await store.update(record.id, {
    applied_at: new Date().toISOString(),
    applied_patch_digest: patchDigest(diff.patch),
  });
  return { outcome: "applied", conflicts: [], isEmpty: false };
}
```

3. Replace `applyWorktree` (export removed) with the private function `applyPatch`, keeping the existing docstring adapted (the "Applies the worktree's patch to the main repository via `git apply --3way`… reversible… Never calls `git commit`… conflict list via `--diff-filter=U`"):

```ts
async function applyPatch(root: string, patch: string): Promise<{ applied: boolean; conflicts: string[] }> {
  const scratchDir = await mkdtemp(join(tmpdir(), "orch-patch-"));
  const patchFile = join(scratchDir, "worktree.patch");
  try {
    await writeFile(patchFile, patch, "utf8");
    try {
      await execFileAsync("git", ["apply", "--3way", patchFile], { cwd: root });
      return { applied: true, conflicts: [] };
    } catch {
      const { stdout } = await execFileAsync("git", ["-C", root, "diff", "--name-only", "--diff-filter=U"]);
      const conflicts = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      return { applied: false, conflicts };
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Verify the pass**

Run: `pnpm vitest run packages/core/src/engine/worktree.test.ts`
Expected: PASS. (The root build stays broken until Task 4 has migrated the facades — normal.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/worktree.ts packages/core/src/engine/worktree.test.ts
git commit -m "Fait de l'application un fait enregistré : applyRecordedWorktree

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `gc` collects worktrees that were applied and unchanged (core)

**Files:**
- Modify: `packages/core/src/engine/gc.ts`
- Test: `packages/core/src/engine/gc.test.ts`

**Interfaces:**
- Consumes: `applyRecordedWorktree`, `patchDigest`, `diffWorktree`, `loadWorktreeHandle` (Task 2); `TaskRecord.applied_at`/`applied_patch_digest` (Task 1).
- Produces: `WorktreeGcReason` gains `"applied"`; `WorktreeGcEntry` gains `applied_at?: string` — consumed by Task 5 (CLI labels) and exposed as-is in `orch gc --json`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/engine/gc.test.ts`, inside the `describe("garbageCollectWorktrees")` (reuse `root`, `git`, `pathExists`, `createRecordedWorktree`). Complete the imports: `TASK_PROTOCOL`, `TaskSchema`, `writeTask` are added to the existing `@orch/protocol` imports; `applyRecordedWorktree` is added to the `./worktree.js` import.

```ts
  /** A finished task whose work was applied through the official path. */
  async function appliedRecordedWorktree(id: string): Promise<TaskRecord> {
    const record = await createRecordedWorktree(id, "succeeded");
    await writeFile(join(record.workspace, `${id}.txt`), "work\n", "utf8");
    const paths = taskPaths(record.task_dir);
    const baseRef = (await git(record.workspace, ["rev-parse", "HEAD"])).trim();
    await writeTask(paths, TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id,
      created_at: record.created_at,
      agent: record.agent,
      objective: record.objective,
      mode: "write",
      isolation: "worktree",
      workspace: record.workspace,
      base_ref: baseRef,
      deadline_ms: 60_000,
      report_path: paths.reportPath,
      events_path: paths.eventsPath,
    }));
    const applied = await applyRecordedWorktree(root, fileTaskStore(root), record);
    expect(applied.outcome).toBe("applied");
    return (await fileTaskStore(root).get(id))!;
  }

  it("removes the worktree of an applied task where nothing moved since", async () => {
    const record = await appliedRecordedWorktree("t_appliquee");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "applied", applied_at: record.applied_at }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await git(root, ["branch", "--list", record.branch!])).trim()).toBe("");
  });

  it("--dry-run announces the collection of an applied task without removing or rewriting", async () => {
    const record = await appliedRecordedWorktree("t_appliquee_dry");

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "would_remove", reason: "applied" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect((await fileTaskStore(root).get(record.id))?.applied_patch_digest).toBe(record.applied_patch_digest);
  });

  it("keeps a worktree modified since its application, applied_at exposed", async () => {
    const record = await appliedRecordedWorktree("t_retouchee");
    await writeFile(join(record.workspace, "t_retouchee.txt"), "touch-up after the application\n", "utf8");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified", applied_at: record.applied_at }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
  });

  it("verification impossible (task.json gone): kept, never removed on a doubt", async () => {
    const record = await appliedRecordedWorktree("t_sans_task_json");
    await rm(taskPaths(record.task_dir).taskFile, { force: true });

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
  });
```

- [ ] **Step 2: Verify the failure**

Run: `pnpm vitest run packages/core/src/engine/gc.test.ts`
Expected: FAIL — the four new tests (reason `"applied"` unknown, applied worktrees kept instead of removed).

- [ ] **Step 3: Implement**

In `packages/core/src/engine/gc.ts`:

1. Extend the existing worktree import: `import { diffWorktree, listGitWorktrees, loadWorktreeHandle, patchDigest, removeWorktree, repoRoot } from "./worktree.js";`.

2. `export type WorktreeGcReason = "clean" | "modified" | "applied" | "active" | "inspection_failed";`

3. In `WorktreeGcEntry`, after `status?: TaskStatus;`:

```ts
  /**
   * The instant of the last application (`orch apply`) carried by the
   * record, restored as-is: it is what distinguishes, among the kept
   * `modified` ones, those that were applied and then touched up.
   */
  applied_at?: string;
```

4. In `Candidate`, add `record?: TaskRecord;` and fill it in `recordedCandidates` (`record,` next to `id: record.id`). Orphans have none.

5. Add the private function, above `garbageCollectWorktrees`:

```ts
/**
 * Does the worktree of an applied task carry exactly what was applied? True
 * only when the record bears witness to an application (`applied_at` +
 * digest) and the recomputed patch — via the same `diffWorktree` as the
 * application, the only way to make the digests comparable — still carries
 * the same digest. Any failure of the verification (task.json gone, git
 * failing) answers no: we never remove on a doubt.
 *
 * `diffWorktree` places an `add --intent-to-add` in the candidate
 * worktree's index, including under `--dry-run`: it is the index of a
 * disposable worktree, already traversed by the application itself, and the
 * gesture is necessary — without it, untracked files would be missing from
 * the patch and the digest would never match. The real workspace and the
 * store, for their part, remain untouched under `--dry-run`.
 */
async function appliedAndUnchanged(record: TaskRecord | undefined): Promise<boolean> {
  if (!record?.applied_at || !record.applied_patch_digest) return false;
  try {
    const handle = await loadWorktreeHandle(record);
    if (!handle) return false;
    const diff = await diffWorktree(handle);
    return patchDigest(diff.patch) === record.applied_patch_digest;
  } catch {
    return false;
  }
}
```

6. In the loop of `garbageCollectWorktrees`: enrich `common` —

```ts
    const common = {
      id: candidate.id,
      path: candidate.handle.path,
      branch: candidate.handle.branch,
      orphan: candidate.orphan,
      status: candidate.status,
      ...(candidate.record?.applied_at ? { applied_at: candidate.record.applied_at } : {}),
    };
```

then replace the final block (from `if (modified && !options.force) {` up to and including `entries.push({ ...common, action, reason: modified ? "modified" : "clean" });`) with:

```ts
    let reason: WorktreeGcReason = "clean";
    if (modified) {
      if (await appliedAndUnchanged(candidate.record)) {
        // The current patch is the one that was applied: the worktree no
        // longer carries anything unique, it is collectable like a clean one.
        reason = "applied";
      } else if (!options.force) {
        entries.push({ ...common, action: "kept", reason: "modified" });
        continue;
      } else {
        reason = "modified";
      }
    }

    const action: WorktreeGcAction = options.dryRun ? "would_remove" : "removed";
    if (!options.dryRun) {
      try {
        await removeWorktree(repo, candidate.handle);
      } catch (error) {
        // A residue git does not know about (creation interrupted before it
        // was registered): say it, rather than failing the whole cleanup on
        // a directory git refuses to take back in hand.
        entries.push({
          ...common,
          action: "kept",
          reason: "inspection_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    entries.push({ ...common, action, reason });
```

7. Update the module's header docstring: "a finished task is only removed if its worktree is clean **or if its patch was applied and has not moved since (`applied_at` + digest, set by `applyRecordedWorktree`)**, unless explicitly requested with `force`".

- [ ] **Step 4: Verify the pass**

Run: `pnpm vitest run packages/core/src/engine/gc.test.ts`
Expected: PASS — the four new tests and all existing ones.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/gc.ts packages/core/src/engine/gc.test.ts
git commit -m "Apprend au gc à collecter les worktrees appliqués et inchangés

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The apply facades (CLI and MCP) reduce to the helper

**Files:**
- Modify: `packages/cli/src/commands/tasks.ts` (`runApply`, ~lines 374-401, and the `@orch/core` import up top)
- Modify: `packages/mcp-server/src/tools/apply.ts`
- Test: `packages/cli/src/commands/tasks.test.ts`, `packages/mcp-server/src/tools/apply.test.ts`

**Interfaces:**
- Consumes: `applyRecordedWorktree` and `RecordedApplyResult` (Task 2).
- Produces: CLI/MCP outputs unchanged for the user (same messages, same exit codes, same JSON) — the only addition: the record now carries the application fields.

- [ ] **Step 1: Write the failing tests**

In `packages/mcp-server/src/tools/apply.test.ts`: in the existing test "applies to the main repository the diff of a task isolated in a worktree", after the assertion on the content of `nouveau.txt`, add:

```ts
        const record = await session.store.get(taskId);
        expect(record?.applied_at).toBeDefined();
        expect(record?.applied_patch_digest).toMatch(/^[0-9a-f]{64}$/);
```

and in the test "inplace isolation: nothing to apply, applied: true", add at the end:

```ts
        const record = await session.store.get(taskId);
        expect(record?.applied_at).toBeUndefined();
```

In `packages/cli/src/commands/tasks.test.ts`: locate the existing test that exercises `runApply` with success (in the describe "orch logs / cancel / diff / apply — on a store populated by real tasks", ~line 129; search for `runApply`). After the existing success assertion, add the same three assertion lines on the record (via `fileTaskStore(root).get(<the test's id>)` — reuse the test's identifier variable).

- [ ] **Step 2: Verify the failure**

Run: `pnpm vitest run packages/mcp-server/src/tools/apply.test.ts packages/cli/src/commands/tasks.test.ts`
Expected: FAIL — `applied_at` is `undefined` after apply (the facades still call the old path, which moreover no longer exists: compilation error on `applyWorktree`).

- [ ] **Step 3: Implement**

`packages/mcp-server/src/tools/apply.ts` — replace the core import with `import { applyRecordedWorktree } from "@orch/core";` and the body of `orchApply` with:

```ts
export async function orchApply(session: McpSession, input: OrchApplyInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Unknown task: "${input.task_id}".`);

  const result = await applyRecordedWorktree(session.root, session.store, record);
  if (result.outcome === "conflicts") {
    return jsonResult({ task_id: input.task_id, applied: false, conflicts: result.conflicts });
  }
  // "no_worktree" stays applied: true — the tool's existing contract for
  // inplace or no-change tasks, described in its description.
  return jsonResult({ task_id: input.task_id, applied: true, conflicts: [] });
}
```

`packages/cli/src/commands/tasks.ts` — in the `@orch/core` import, replace `applyWorktree` with `applyRecordedWorktree` (and remove `loadWorktreeHandle` if it is now only used by `runDiff` — check: `runDiff` uses it, keep it). Body of `runApply`:

```ts
export async function runApply(root: string, id: string, options: ApplyOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Unknown task: "${id}".`);
    return EXIT_USAGE;
  }

  const result = await applyRecordedWorktree(root, store, record);
  if (result.outcome === "no_worktree") {
    const message = `Task "${id}": isolation "${record.isolation}", nothing to apply.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: [], message });
    else writeLine(io.stdout, message);
    return EXIT_OK;
  }

  if (result.outcome === "conflicts") {
    const message = `Conflicts while applying task "${id}": ${result.conflicts.join(", ")}.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: result.conflicts });
    else printError(io, message);
    return EXIT_RUNTIME;
  }

  if (options.json) printJson(io, { id, applied: true, conflicts: [] });
  else writeLine(io.stdout, `Task "${id}" applied to the main repository.`);
  return EXIT_OK;
}
```

- [ ] **Step 4: Verify the pass and the build**

Run: `pnpm vitest run packages/mcp-server/src/tools/apply.test.ts packages/cli/src/commands/tasks.test.ts && pnpm build`
Expected: PASS and root build green (no reference to `applyWorktree` left).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/apply.ts packages/mcp-server/src/tools/apply.test.ts packages/cli/src/commands/tasks.ts packages/cli/src/commands/tasks.test.ts
git commit -m "Réduit les deux façades apply au chemin enregistré du core

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI gc labels and advice

**Files:**
- Modify: `packages/cli/src/commands/gc.ts` (`reasonLabel` line 39, `keptAdvice` line 60)
- Test: `packages/cli/src/commands/gc.test.ts`

**Interfaces:**
- Consumes: `WorktreeGcEntry.applied_at`, reason `"applied"` (Task 3).
- Produces: nothing new for the other tasks — human outputs only. The JSON already exposes `applied_at` and the reason via the direct serialization of the entries.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/commands/gc.test.ts`: reuse the file's helpers (repository setup, populated store, capturing `Io` — mirror of the existing test that verifies the "unintegrated changes" label). Add two tests; to fabricate an applied task, copy the `appliedRecordedWorktree` helper from `packages/core/src/engine/gc.test.ts` (same `@orch/protocol` and `@orch/core` imports — `applyRecordedWorktree`, `TaskSchema`, `TASK_PROTOCOL`, `writeTask`, `taskPaths`):

```ts
  it("labels a worktree collected after application as \"applied\"", async () => {
    await appliedRecordedWorktree("t_appliquee_cli");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(stdout()).toContain("removed");
    expect(stdout()).toContain("applied to the workspace, nothing new since");
  });

  it("labels a worktree touched up after apply as \"modified since its application\", with the adapted advice", async () => {
    const record = await appliedRecordedWorktree("t_retouchee_cli");
    await writeFile(join(record.workspace, "t_retouchee_cli.txt"), "touch-up\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(stdout()).toContain("modified since its application");
    expect(stdout()).toContain("to see what changed since the application");
  });
```

(`stdout()`/`io`: reuse the capture mechanism of the file's existing tests; do not invent a second one.)

- [ ] **Step 2: Verify the failure**

Run: `pnpm vitest run packages/cli/src/commands/gc.test.ts`
Expected: FAIL — `reasonLabel` does not know `"applied"` (`undefined` returned in the cell) and the adapted advice does not exist.

- [ ] **Step 3: Implement**

In `packages/cli/src/commands/gc.ts`:

```ts
function reasonLabel(entry: WorktreeGcEntry): string {
  switch (entry.reason) {
    case "clean":
      return entry.orphan ? "orphan, no changes" : "finished task, no changes";
    case "applied":
      return "applied to the workspace, nothing new since";
    case "modified":
      if (entry.action !== "kept") return "unintegrated changes, forced removal";
      return entry.applied_at ? "modified since its application" : "unintegrated changes";
    case "active":
      return entry.status === "pending" ? "pending task" : "running task";
    case "inspection_failed":
      return `inspection failed${entry.error ? `: ${entry.error}` : ""}`;
  }
}
```

and in `keptAdvice`, between the orphan case and the general case (keep the existing docstring):

```ts
  if (entry.applied_at) {
    return `"${entry.id}": applied then modified — "orch diff ${entry.id}" to see what changed since the application, "orch apply ${entry.id}" to re-apply.`;
  }
```

(The orphan case must stay **before**: an orphan has no record, hence never an `applied_at` — the current order `orphan` then `applied_at` then general is the right one. `jsonEntry` stays unchanged: its `diff_command`/`apply_command` also hold for a kept "modified since its application".)

- [ ] **Step 4: Verify the pass**

Run: `pnpm vitest run packages/cli/src/commands/gc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/gc.ts packages/cli/src/commands/gc.test.ts
git commit -m "Dit « appliqué » quand le gc collecte un worktree appliqué

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The deposited knowledge says the invocation and the full cycle

**Files:**
- Modify: `.claude/skills/orch/references/cli.md`
- Modify: `.claude/skills/orch/SKILL.md`
- Modify: `.claude/skills/orch/references/troubleshooting.md`
- Regenerate: `packages/core/src/agent-assets.generated.ts` (via `pnpm run assets:sync`, never by hand)

**Interfaces:**
- Consumes: the behavior delivered by Tasks 2-5 (the texts describe it).
- Produces: the regenerated asset catalog, which `orch init` will deposit into projects.

- [ ] **Step 1: First commit the repository's in-flight modification**

`git status` carries a modification **predating this plan** (skill description tightened, already synchronized into the catalog). Commit it alone so the rest stays reviewable:

```bash
git add .claude/skills/orch/SKILL.md packages/core/src/agent-assets.generated.ts
git commit -m "Resserre la description de déclenchement de la skill orch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If `git status` is clean at this point, skip this step.)

- [ ] **Step 2: Edit `references/cli.md`**

Insert, between the introduction paragraph ("…passing raw arguments through to a provider.") and `## Getting started`:

```markdown
## Invocation

`orch` is a standalone binary on the PATH — never a dependency of the project. `npx orch` always
fails with `could not determine executable to run`, whatever the project's `package.json` says:
call `orch` directly. When in doubt, `command -v orch` says where it lives and `orch doctor` says
what it can reach.
```

Then, under the table containing the `orch gc` row (~line 80), add this paragraph (adapt the exact location to the file's structure — right after the table if no prose follows it):

```markdown
`orch gc` removes the worktrees and branches of finished tasks. A worktree whose diff was applied
(`orch apply`) is collected as long as nothing changed in it since the application — the
application is recorded on the task, so gc never has to guess. What it keeps is exactly the work
that was never applied, or modified after it: settle it with `orch diff`/`orch apply`, or discard
it knowingly with `--force`.
```

- [ ] **Step 3: Edit `SKILL.md`**

In the paragraph "**Applying is a decision, not a final step.**", replace:

```
State what is being applied and which criterion it met; when it met none, say so and leave the
worktree unapplied — `orch gc` collects the worktrees of finished tasks, keeping any that still
carry changes unless `--force` (see `references/cli.md`). A diff nobody can defend is not cheaper
for having been written elsewhere.
```

with:

```
State what is being applied and which criterion it met; when it met none, say so and leave the
worktree unapplied. Close the loop with `orch gc` once the session's delegations are settled:
applied worktrees are collected on their own, and what gc keeps is exactly the work never applied
— or modified since its application — to settle with `orch diff`/`orch apply` rather than a
reflexive `--force` (see `references/cli.md`). A diff nobody can defend is not cheaper for having
been written elsewhere.
```

- [ ] **Step 4: Edit `references/troubleshooting.md`**

Add at the end of the file, in the format of the existing entries:

```markdown
## `npx orch` fails: could not determine executable to run

**Symptom.** Any `npx orch …` invocation fails immediately with npm's
`could not determine executable to run`.

**Cause.** `orch` is a standalone binary installed on the PATH, never an npm dependency of the
project: there is nothing under `node_modules/.bin` for npx to find, whatever the project.

**Remedy.** Call `orch` directly. `command -v orch` tells where the binary lives; `orch doctor`
confirms what it can reach. If the shell finds nothing, the installation is missing — not the
project's `package.json`.

## `orch gc` keeps a worktree whose diff was already applied

**Symptom.** `orch gc` reports a finished task's worktree as kept — "unintegrated changes", or
"modified since its application" — even though its diff has landed in the workspace.

**Cause.** Three possibilities. The diff entered the workspace by another path than `orch apply`
(manual copy, re-implementation): the application was never recorded, and gc will not deduce it
from content. Or the worktree changed after the application: what changed is precisely what was
never applied. Or the application predates the version of orch that records it.

**Remedy.** `orch diff <id>` shows what the worktree still carries. Re-run `orch apply <id>` if it
should land; once settled — or when the work is known to be integrated — `orch gc --force` removes
what gc could not prove applied.
```

- [ ] **Step 5: Regenerate the catalog and verify**

```bash
pnpm run assets:sync
pnpm vitest run packages/core/src/agent-assets.drift.test.ts packages/core/src/agent-assets.invariants.test.ts packages/core/src/agent-assets.test.ts
```

Expected: PASS (no drift between sources and catalog).

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/orch/SKILL.md .claude/skills/orch/references/cli.md .claude/skills/orch/references/troubleshooting.md packages/core/src/agent-assets.generated.ts
git commit -m "Documente l'invocation du binaire et le cycle apply → gc dans les assets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification, binary, deployment into `support`

**Files:**
- No source creation or modification — execution and verification.

**Interfaces:**
- Consumes: everything above.
- Produces: `dist-bin/orch` binary rebuilt (the `~/.local/bin/orch` symlink already points at it); `support` project refreshed and purged.

- [ ] **Step 1: Full suite and build**

```bash
pnpm build && pnpm test
```

Expected: all green. Otherwise: fix before going further, never deploy on red.

- [ ] **Step 2: Rebuild the binary**

```bash
pnpm run build:binary
orch --version
```

Expected: the version prints (the `~/.local/bin/orch → dist-bin/orch` symlink picks up the new build with no further gesture).

- [ ] **Step 3: Refresh the `support` assets**

```bash
cd /Users/tharsan/Workspace/koumalabs/support && orch init --json
```

Expected: JSON output with the `assets` key; `.orch/config.toml` and `.orch/roles/*.md` untouched (documented behavior of the refresh without `--force`). Verify that the project's `.claude/skills/orch/references/cli.md` now contains "standalone binary on the PATH".

- [ ] **Step 4: Purge the two inherited worktrees**

Tasks `t_026622fbf0984832bbf31e747c4f2208` and `t_8a403767545d402a88b43c0112fcedbf` date from before the recording of the application fact: their integration was verified file by file on 2026-08-12 (spec, § Deployment). In `/Users/tharsan/Workspace/koumalabs/support`:

```bash
orch gc --dry-run   # expected: both kept, "unintegrated changes" — normal, records predate the mechanism
orch gc --force     # expected: both removed, reason "unintegrated changes, forced removal"
orch gc             # expected: "No worktrees to clean."
```

- [ ] **Step 5: End-to-end verification of the new cycle (optional but recommended)**

In a scratch repository (e.g. `/Users/tharsan/Workspace/orch-essai`), run through a real worktree delegation, then:

```bash
orch apply <task_id>   # applies and records
orch gc --dry-run      # expected: "would be removed", reason "applied to the workspace, nothing new since"
orch gc                # expected: removed without --force
```

## Plan self-review

- **Spec coverage:** recorded apply (Tasks 1-2), gc collection + labels (Tasks 3, 5), facades (Task 4), invocation + cycle + troubleshooting knowledge (Task 6), tests for all three parts (Tasks 1-5), `support` deployment (Task 7). The spec's dry-run point of vigilance is settled in Task 3 (docstring of `appliedAndUnchanged`: the disposable worktree's index may be touched, the workspace and the store never) and tested (dry-run test: store not rewritten, worktree present).
- **Consistent types:** `applied_at`/`applied_patch_digest` (Tasks 1→2→3→4), `RecordedApplyResult.outcome` (`"applied" | "conflicts" | "no_worktree"`) consumed as-is in Task 4, reason `"applied"` and `WorktreeGcEntry.applied_at` (Task 3) consumed in Task 5.
- **No placeholders:** every step carries its code or its command; the only two cross-references (capture helpers of the existing CLI tests, `appliedRecordedWorktree` helper copied from the core test) name their exact source.
