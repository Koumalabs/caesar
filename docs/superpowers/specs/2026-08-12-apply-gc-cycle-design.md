# Closing the apply → gc cycle, and telling agents how to invoke orch

Date: 2026-08-12
Status: validated (design approved section by section)

## Problem

Two incidents observed in the `support` project, where an agent was using orch:

1. **`npx orch gc` failed** ("could not determine executable to run"): `orch`
   is a standalone binary installed on the PATH, not an npm dependency of the
   project. No asset deposited by `orch init` says how to invoke the CLI;
   in a Node project, `npx` is an agent's reflex.

2. **`orch gc` refused to collect two worktrees** of `succeeded` tasks,
   reason "unintegrated changes", even though their content was fully
   integrated into the workspace (commit `c08743f` of `support`).
   The cause is mechanical, not behavioral: `orch apply` (CLI and MCP alike)
   applies the patch to the workspace but **records nothing** in the store and
   does not touch the worktree. The worktree stays dirty by construction, and
   `gc` — which judges only by the worktree's `git status --porcelain`
   (`worktreeHasChanges`, `packages/core/src/engine/gc.ts`) — therefore
   **always** refuses, even after a perfectly disciplined cycle. Documenting
   the cycle is not enough: an exemplary agent hits the same refusal again.

## Decision

Two parts, both necessary:

- **Mechanics**: `apply` records the fact of the application in the task's
  record (a dated, positive fact, never a deduction — consistent with the
  store's philosophy); `gc` collects the worktree of a finished, applied
  task whose content has not changed since.
- **Knowledge**: the assets deposited by `orch init` say how to invoke the
  binary and close the delegate → diff → apply → gc cycle.

The "apply cleans up the worktree" option was rejected: it would make `apply`
destructive (the only other copy of the diff would disappear), against its
"reversible, side-effect-free" contract. The "dated fact alone, without a
digest" option was rejected: it would throw away, without warning, edits made
in the worktree after the apply.

## Mechanical part

### 1. `apply` records the fact of the application

A shared helper in `@orch/core` — `applyRecordedWorktree(root, store,
record)` (indicative name) — becomes the only application path:

1. computes the diff (`diffWorktree`);
2. applies it (current `applyWorktree`, `git apply --3way`, never a commit);
3. **on success over a non-empty diff**, writes into the `TaskRecord`:
   - `applied_at`: ISO timestamp (same shape as `created_at`, `ended_at`);
   - `applied_patch_digest`: sha256 of the applied patch's text.

An empty diff or a failure (conflicts) records nothing. A new successful apply
overwrites both fields (the last application is the one that counts).

The two facades reduce to this helper:
- CLI `orch apply` (`packages/cli/src/commands/tasks.ts`);
- MCP tool `orch_apply` (`packages/mcp-server/src/tools/apply.ts`).

`TaskRecord` (`packages/core/src/store.ts`) gains these two optional fields;
the protocol schema that exposes tasks as JSON
(`packages/protocol/src/jsonschema.ts` and friends) is updated.

### 2. `gc` collects applied worktrees

In `garbageCollectWorktrees` (`packages/core/src/engine/gc.ts`), for a
candidate that is **non-orphan, from a finished task, carrying `applied_at`**:

- load the **real** handle via `loadWorktreeHandle(record)` — indispensable:
  today the gc fabricates handles with a bogus `baseRef: "HEAD"`, unusable
  for a diff;
- recompute the patch with the **same** `diffWorktree` as the apply (the
  digests are only comparable if the computation is identical);
- compare the sha256s:
  - **identical** → removed, new reason `applied`
    ("applied to the workspace, nothing new since");
  - **different** → kept, reason `modified`, distinct label
    "modified since its application", adapted advice under the table
    (`orch diff <id>` to see what changed since).

Orphans and tasks without `applied_at` keep the current behavior.
`--force` keeps its semantics (also removes the kept, modified ones).

**Dry-run point of vigilance**: `diffWorktree` places intent-to-add `git add`s
in the worktree's index (unlike `worktreeHasChanges`, guarded by
`GIT_OPTIONAL_LOCKS=0`). It is the index of a disposable worktree already
traversed by the apply, but the gc's "`--dry-run` writes nothing" contract
will have to be either preserved (digest computation without touching the
index) or clarified in the module's documentation. To be settled at
implementation time, with a test.

The `applied` reason travels through the `WorktreeGcReason` type, the JSON
output of `orch gc --json`, and the CLI label (`reasonLabel` in
`packages/cli/src/commands/gc.ts`).

## Knowledge part

Sources in **this repository** (`.claude/skills/orch/` and `.claude/commands/`),
regenerated into the catalog by `pnpm run assets:sync`, deposited into
projects by `orch init` (the refresh without `--force` touches neither
`.orch/config.toml` nor the roles):

- **`references/cli.md`** — up top: `orch` is a standalone binary on the
  PATH, never an npm dependency; **`npx orch` always fails**;
  `command -v orch` / `orch doctor` to verify presence.
- **`SKILL.md`** — close the cycle: after `orch apply`, the worktree is
  collectable; `orch gc` at the end of the session; a worktree kept as
  "unintegrated changes" signals genuinely unintegrated work,
  to be settled (`orch diff` / `orch apply`) rather than forced by reflex.
- **`references/troubleshooting.md`** — two entries:
  - "could not determine executable to run" → invocation via `npx` →
    call the binary directly;
  - "gc keeps a worktree that was nonetheless applied" → version predating
    this fix, or worktree modified since the application.

## Tests

- `gc.test.ts`: applied task with matching digest → removed (real **and**
  dry-run); worktree touched up after apply → kept with the label
  "modified since its application"; task without `applied_at` → behavior
  unchanged.
- Apply facades (CLI and MCP): fields written on success; nothing on conflict;
  nothing on an empty diff.
- Store: round-trip of `TaskRecord` with and without the new fields
  (compatibility with existing records).

## Deployment

1. Fix published (`orch` binary reinstalled).
2. In `support`: re-run `orch init` (refreshes the deposited assets).
3. The two currently blocked worktrees (`t_026622…`, `t_8a4037…`) predate the
   recording of the fact: purge them once and for all with
   `orch gc --force` (content verified integrated on 2026-08-12; the
   workspace version of `business-hours.ts` is an improved superset of the
   worktree's).

## Out of scope

- Integration detection by comparing content against the workspace (fragile:
  legitimate integration may rework the content, as here).
- Any change to the semantics of `--force` or the orphan sweep.
- An additional task status ("applied" remains a fact on the record, not a
  seventh status — same reasoning as `sweepAbandonedTasks`).
