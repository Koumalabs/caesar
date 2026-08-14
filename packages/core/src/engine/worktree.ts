/**
 * Git isolation: each isolated task runs in a disposable worktree, on
 * a dedicated branch, never committed by the engine. This is what makes the
 * runner's `"auto"` isolation rule observable rather than declarative:
 * an agent that writes despite a read-only instruction leaves a trace
 * that `git diff` reveals, contained outside the main repository.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Change } from "@caesar/protocol";
import { readTask, taskPaths } from "@caesar/protocol";
import type { TaskRecord, TaskStore } from "../store.js";
import { isUnderPath } from "./materialize.js";

const execFileAsync = promisify(execFile);

/** Root of the git repository containing `dir`, or `null` if `dir` is not inside a git repository. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * True if the repository carries at least one commit.
 *
 * A freshly initialized repository carries none: its branch is unborn and
 * `HEAD` points to nothing. `git worktree add … HEAD` then fails there with a
 * `fatal: invalid reference: HEAD` that nothing ties to its cause. The case
 * is distinct from "this is not a git repository" — `repoRoot` succeeds — and
 * calls for a different remedy: a first commit.
 */
export async function hasCommits(repo: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

/**
 * Root of the repository containing `dir`, but **only if it can actually
 * host a worktree** — hence `null` both outside a repository and in a
 * repository without a single commit.
 *
 * This is the question the two points that decide isolation ask themselves
 * (`resolveDelegation` and `prepareIsolation`), and they each used to ask it
 * their own way. Composing it here once keeps them from diverging: an
 * `inplace` refused early then accepted late — or the reverse — would not be
 * a hardening but an inconsistency. `prepareIsolation` keeps its own
 * breakdown, because it must distinguish the two causes to name their
 * remedy; here, only the conclusion matters.
 */
export async function usableRepoRoot(dir: string): Promise<string | null> {
  const root = await repoRoot(dir);
  if (root === null) return null;
  return (await hasCommits(root)) ? root : null;
}

/**
 * True if git ignores the worktree that task `taskId` is about to occupy.
 *
 * Step 0 of the `superpowers:using-git-worktrees` skill — "MUST verify
 * directory is ignored before creating worktree". `caesar init` writes
 * `.caesar/wt/` into the `.gitignore` and nobody rechecks; a
 * hand-rewritten `.gitignore`, or a project initialized by an earlier
 * version, leaves the worktree visible to the main repository.
 *
 * The question is asked about the **exact path to be created**, not about the
 * directory containing it: verified, a pattern ending with a slash
 * (`.caesar/wt/`, the one `caesar init` writes) only applies to `.caesar/wt` on
 * the condition that this directory already exists on disk — a directory
 * pattern cannot apply to what git does not know to be a
 * directory. Querying the path we are about to occupy sidesteps the question
 * entirely, and answers the one that actually matters.
 *
 * `--no-index` so that the answer is about the rules, independently of what
 * the index already contains.
 */
export async function worktreesDirIgnored(repo: string, taskId: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repo, "check-ignore", "-q", "--no-index", "--", join(".caesar", "wt", taskId)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Describes the gap between the root the orchestrator delegates on and
 * the one where the caller actually works — `null` when the two coincide,
 * which is the ordinary case.
 *
 * `caesar mcp install` registers `--root <path>` once and for all
 * (`mcp-registration.ts`), and `caesar_delegate` imposes that path as the
 * workspace of every task. As long as the main agent works where the install
 * was done, everything lines up. But let it move into a worktree itself —
 * which the `superpowers:using-git-worktrees` skill precisely recommends it
 * do — and the orchestrator keeps delegating on the original repository:
 * the sub-agents work in a tree nobody is looking at anymore, and
 * their diffs apply beside the current branch.
 *
 * Comparison on the worktree root (`repoRoot`), not on the common repository:
 * two worktrees of the same repository are precisely the case to flag.
 * Silent when the current directory is not inside a repository — there is
 * then no reason to believe it designates a place of work.
 */
export async function describeWorkspaceMismatch(sessionRoot: string, cwd: string): Promise<string | null> {
  const [here, there] = await Promise.all([repoRoot(cwd), repoRoot(sessionRoot)]);
  if (here === null || there === null || here === there) return null;

  return (
    `The orchestrator delegates on "${sessionRoot}", but the current working directory belongs to repository "${here}". ` +
    `The sub-agents will therefore work in a different tree from yours, and their modifications will not appear ` +
    `where you expect them. Rerun "caesar mcp install" from "${here}", or run "caesar mcp serve --root ${here}".`
  );
}

export interface GitWorktreeEntry {
  path: string;
  /** Short branch name (`caesar/t_…`), absent for a worktree on a detached HEAD. */
  branch?: string;
}

/**
 * The worktrees git actually knows for this repository, path **and**
 * branch — `git worktree list --porcelain`, the only source of truth on the
 * matter.
 *
 * `caesar gc` used to infer an orphan worktree's branch from its directory
 * name (`caesar/<dirname>`). That was true as long as both were
 * built together by `createWorktree`; it stops being true as soon as the
 * branch name gains the slightest independence — and an assumption that only
 * holds by coincidence ends up leaving branches behind. The
 * directory, for its part, remains listed by git even when its tree has been
 * erased by hand: `git worktree list` reports it with `prunable`, and
 * that is also what allows cleaning it up.
 *
 * The first worktree returned by git is always the main repository itself:
 * the caller must filter it out, here by location (`.caesar/wt/`).
 */
export async function listGitWorktrees(repo: string): Promise<GitWorktreeEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"]));
  } catch {
    return [];
  }

  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ") && current) {
      // `branch refs/heads/caesar/t_x` → `caesar/t_x`. A detached worktree does
      // not have this line at all, hence the optional field.
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "" && current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  /**
   * The worktree's starting point, **resolved to a SHA** at the moment of its
   * creation — never the symbolic string `"HEAD"`.
   *
   * The distinction carries the entire reliability of the diff: `HEAD`
   * designates the last commit *of the worktree*, which moves as soon as the
   * agent commits. A diff against `HEAD` would then become empty, `caesar`
   * would conclude "no changes" and `caesar apply` would apply nothing — the
   * silent erasure of all the work. A SHA, for its part, does not move.
   *
   * Remains a free-form string for backward compatibility: `loadWorktreeHandle`
   * re-reads the `task.base_ref` of tasks created before this change, where
   * `"HEAD"` had been persisted as-is.
   */
  baseRef: string;
  /**
   * Paths the orchestrator itself placed in the worktree
   * (`[worktree] copy`/`link` — see `materializeUntracked`), to be removed
   * from the diff: it is not the agent's work, and a copied `.env` has no
   * business in a `caesar apply`.
   *
   * Carried by the handle rather than applied by the runner, so that *every*
   * consumer of the diff inherits it — `caesar diff` and `caesar apply` each
   * recompute it on their own, long after the task ends.
   * Prefix semantics: an excluded directory excludes what it contains.
   */
  excluded?: string[];
}

/**
 * Creates a disposable worktree under `<root>/.caesar/wt/<taskId>`, on a new
 * branch `caesar/<taskId>` starting from `baseRef` (default `HEAD`).
 *
 * `root` must be the repository root (typically the result of
 * `repoRoot(workspace)`): the git commands run there, and that is where
 * the administrative directory `.caesar/wt` lives.
 */
/**
 * Branch name of a workshop: `caesar/<role or agent>/<objective>-<8 chars>`.
 *
 * `caesar/t_3f2a91c0…` is unreadable in a `git branch`, and becomes all the
 * more so as the branch ceases to be an implementation detail: in
 * a workshop, the sub-agent commits to it, and the user re-reads it. The
 * suffix carries the uniqueness, the rest carries the meaning.
 *
 * The **directory**, for its part, remains `.caesar/wt/<taskId>`: it is the key
 * of the store, of the anti-GC lease and of the task paths. The two now have
 * independent names — hence the GC's switch to `git worktree list` to learn
 * the branch, rather than inferring it from the directory.
 *
 * `git check-ref-format` forbids spaces, `..`, `~^:?*[`, segments
 * starting with a dot or ending with `.lock`, and consecutive slashes.
 * Rather than enumerating the forbidden, we only allow a safe alphabet.
 */
export function worktreeBranchName(taskId: string, objective: string, label?: string): string {
  const parts = ["caesar"];
  const scope = slugForBranch(label ?? "");
  if (scope) parts.push(scope);

  const summary = slugForBranch(objective).slice(0, 40).replace(/-+$/, "");
  const suffix = taskId.replace(/^t_/, "").slice(0, 8) || "task";
  parts.push(summary ? `${summary}-${suffix}` : suffix);
  return parts.join("/");
}

/** Reduces free-form text to `[a-z0-9-]`, without a leading or trailing hyphen — always acceptable to `git check-ref-format`. */
function slugForBranch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function createWorktree(
  root: string,
  taskId: string,
  baseRef = "HEAD",
  naming?: { objective: string; label?: string },
): Promise<WorktreeHandle> {
  const branch = naming ? worktreeBranchName(taskId, naming.objective, naming.label) : `caesar/${taskId}`;
  const path = join(root, ".caesar", "wt", taskId);
  await mkdir(join(root, ".caesar", "wt"), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "-b", branch, path, baseRef], { cwd: root });
  // Resolved to a SHA rather than kept as-is: see `WorktreeHandle.baseRef`.
  // After `worktree add`, not before: what gets recorded is indeed the commit
  // the worktree actually carries, not the one `baseRef` designated at an
  // instant that may already be outdated.
  const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"]);
  return { path, branch, baseRef: stdout.trim() };
}

/**
 * Removes the worktree and its branch. Affects neither the history nor the
 * other branches.
 *
 * Nor does it destroy what a symlink in the worktree designates inside the
 * main repository — a `node_modules` placed by `[worktree] link`, notably.
 * This requires no particular precaution, and it is verified rather than
 * assumed (see the tests of this module and of `gc.ts`): recursively deleting
 * a tree detaches the links it contains instead of following them,
 * for `git worktree remove --force` as well as for `fs.rm`. A preventive
 * sweep of the links before deletion was considered then discarded: it would
 * have made every cleanup pay for the full traversal of the worktree —
 * precisely where a `node_modules` has just been cloned — to guard against a
 * risk that does not exist.
 */
export async function removeWorktree(root: string, handle: WorktreeHandle): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", handle.path, "--force"], { cwd: root });
  await execFileAsync("git", ["branch", "-D", handle.branch], { cwd: root });
}

export interface WorktreeDiff {
  files: Change[];
  patch: string;
  isEmpty: boolean;
}

/**
 * Diffs the worktree against its starting point — `handle.baseRef`, the SHA
 * frozen at creation, **never `HEAD`**.
 *
 * This function used to diff against `HEAD` under a then-true hypothesis:
 * "agents do not commit". It no longer holds since the worktree became a
 * workshop where the sub-agent installs, runs and verifies — an agent that
 * commits there would move `HEAD` onto its own work, and the diff would come
 * out empty. `caesar` would conclude "no changes", `caesar apply` would apply
 * nothing, and the reconciliation the whole system rests on would vanish
 * without a word. Diffing against the starting SHA makes the result identical
 * whether the agent commits or not.
 *
 * `add -A --intent-to-add` remains necessary for the opposite case, that of
 * the agent that does not commit: a created file is invisible to git as long
 * as it is neither staged nor committed. This command records its existence
 * without staging its content, which is enough to make it appear in the diff.
 * It is acceptable here precisely because the worktree is disposable: we
 * pollute the index of no repository that matters.
 */
export async function diffWorktree(handle: WorktreeHandle): Promise<WorktreeDiff> {
  await execFileAsync("git", ["-C", handle.path, "add", "-A", "--intent-to-add"]);
  const [{ stdout: nameStatus }, { stdout: patch }] = await Promise.all([
    execFileAsync("git", ["-C", handle.path, "diff", "--name-status", handle.baseRef]),
    execFileAsync("git", ["-C", handle.path, "diff", handle.baseRef]),
  ]);
  const files = excludeMaterialized(parseNameStatus(nameStatus), handle.excluded);
  return { files, patch, isEmpty: files.length === 0 };
}

/**
 * Removes from the diff what materialization placed — see `WorktreeHandle.excluded`.
 *
 * Only the file list is filtered, not `patch`: the patch is the text
 * git produces, and refabricating it by slicing would be fragile exactly
 * where it must remain exact. In practice, a materialized path is ignored by
 * git (`materializeUntracked` refuses to place one that would not be), so it
 * appears in neither of the two — this filtering is the safety net for the
 * case where that invariant were ever broken, not the ordinary
 * mechanism.
 */
function excludeMaterialized(files: Change[], excluded: readonly string[] | undefined): Change[] {
  if (!excluded || excluded.length === 0) return files;
  return files.filter((change) => !excluded.some((prefix) => isUnderPath(change.path, prefix)));
}

/**
 * sha256 digest (hex) of a patch's text — computed at the same place on both
 * sides that must compare it: at application time (below) and in the
 * garbage collector (`gc.ts`), which recomputes the patch via the same
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
 * `applied_at` and the digest of the applied patch. Nothing is recorded on
 * an empty diff or on a conflict: the record only bears witness to an
 * application that actually happened, and a new successful apply overwrites
 * it (the last application is authoritative). Without this trace, `caesar gc`
 * could not tell an integrated worktree from a worktree carrying unique
 * work: it refused both, even after a perfectly disciplined
 * cycle (observed on two tasks of the `support` project, 2026-08-12).
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

/**
 * Applies a patch to the main repository via `git apply --3way`,
 * without touching branches or history: reversible, with no side
 * effect on the user's history. Never calls `git commit`.
 *
 * On failure (conflict), returns the list of conflicting files rather
 * than throwing — that list comes from `git diff --diff-filter=U`, hence from
 * the real state of the index after the attempt, not from a fragile decoding
 * of `git apply`'s human-oriented messages.
 */
async function applyPatch(root: string, patch: string): Promise<{ applied: boolean; conflicts: string[] }> {
  const scratchDir = await mkdtemp(join(tmpdir(), "caesar-patch-"));
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

/**
 * Captures the git state of the real workspace (`git status --porcelain`), to
 * compare it before/after an execution in `"inplace"` isolation — see C2/C3
 * of the final review: `git diff` was only the source of truth in `worktree`
 * isolation, never `inplace`, where no reconciliation took place and where a
 * write by a read-only agent was neither contained, nor detected.
 *
 * The administrative directory `.caesar/` (tasks, state, worktrees) is
 * excluded from the pathspec: unlike the disposable worktree — whose tree
 * structurally never contains `.caesar/tasks/<id>` (distinct root,
 * `deps.root` rather than `workspace`) — the real workspace IS `deps.root`
 * for an `inplace` task, and `.caesar/tasks/<id>` is therefore physically
 * created there by the orchestrator itself during execution. Without this
 * exclusion, the mere existence of the task directory would suggest a
 * write by the agent on every `inplace` task, whatever its actual
 * behavior — a systematic false positive far worse than the rare false
 * negative of an agent modifying `.caesar/config.toml` itself
 * (then masked by that same exclusion, all of `.caesar/` being set aside in
 * bulk: `git status` reduces an entirely untracked directory to a single
 * `?? .caesar/` line, which defeats any exclusion pathspec finer
 * than the whole of `.caesar` — verified empirically).
 *
 * Never any `git add` here, unlike `diffWorktree`: the workspace
 * is not disposable, and modifying the user's real index for a
 * mere observation would be a side effect that `"inplace"` isolation does
 * not promise. `null` if `workspace` is not a git repository (or any other
 * error): never an exception, this capture is a safety net, not a
 * requirement.
 */
export async function captureWorkspaceStatus(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspace, "status", "--porcelain", "--", ".", ":(exclude).caesar"]);
    return stdout;
  } catch {
    return null;
  }
}

/** `git status --porcelain` from a path to its two-letter code (`XY`, see `git help status`). */
function parsePorcelainStatus(status: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    // "R  old -> new" for a rename: only the final path matters here.
    const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
    map.set(path.trim(), code);
  }
  return map;
}

function porcelainCodeToAction(code: string): Change["action"] | undefined {
  const x = code[0];
  const y = code[1];
  if (x === "?" || x === "A" || y === "A") return "created";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "M" || y === "M" || x === "U" || y === "U") return "modified";
  return undefined;
}

/**
 * Diffs two `git status --porcelain` snapshots of the same workspace, before
 * and after an execution. Unlike `diffWorktree`, never yields a
 * patch (`patch: ""`): without `git add`, only the list of touched paths
 * can be reliably reconstructed from `git status`, not the diff's content.
 */
export async function diffWorkspaceStatus(workspace: string, before: string): Promise<WorktreeDiff> {
  const after = await captureWorkspaceStatus(workspace);
  if (after === null) return { files: [], patch: "", isEmpty: true };

  const beforeMap = parsePorcelainStatus(before);
  const afterMap = parsePorcelainStatus(after);
  const files: Change[] = [];
  for (const [path, code] of afterMap) {
    if (beforeMap.get(path) === code) continue;
    const action = porcelainCodeToAction(code);
    if (action) files.push({ path, action, summary: "" });
  }
  return { files, patch: "", isEmpty: files.length === 0 };
}

/**
 * Rebuilds a task's `WorktreeHandle` from its record
 * (`TaskRecord`) — `null` if the task did not run in worktree isolation.
 * Shared by `caesar diff`/`caesar apply` (CLI) and `caesar_diff`/`caesar_apply`
 * (MCP server), which each had their own copy before the task 7
 * review: see its correction report.
 */
export async function loadWorktreeHandle(record: TaskRecord): Promise<WorktreeHandle | null> {
  if (record.isolation !== "worktree" || !record.branch) return null;
  const task = await readTask(taskPaths(record.task_dir));
  return {
    path: record.workspace,
    branch: record.branch,
    baseRef: task.base_ref ?? "HEAD",
    // Restored onto the handle so that `caesar diff` and `caesar apply`, which
    // recompute the diff well after the task ends, exclude what the
    // orchestrator had placed — without which a copied `.env` would become
    // applicable again.
    ...(record.excluded_paths ? { excluded: record.excluded_paths } : {}),
  };
}

/** Translates `git diff --name-status` into the common `Change` vocabulary. */
function parseNameStatus(raw: string): Change[] {
  const changes: Change[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split("\t");
    if (!code) continue;

    if (code.startsWith("R")) {
      const [oldPath, newPath] = rest;
      if (newPath) {
        changes.push({ path: newPath, action: "renamed", summary: oldPath ? `renamed from ${oldPath}` : "" });
      }
      continue;
    }

    const path = rest[0];
    if (!path) continue;
    const action = code === "A" ? "created" : code === "M" ? "modified" : code === "D" ? "deleted" : undefined;
    if (action) changes.push({ path, action, summary: "" });
  }
  return changes;
}
