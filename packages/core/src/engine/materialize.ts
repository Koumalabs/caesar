/**
 * The workshop: what must be added to a freshly created git worktree so a
 * subagent can actually work in it.
 *
 * A worktree contains only **tracked** files. Installed dependencies, the
 * `.env`, ignored directories carrying briefs or artifacts are not there —
 * nothing installs, nothing launches, nothing verifies. Isolation therefore
 * became, on a real project, an empty space with nothing to do in it, and
 * bypassing it via `isolation = "inplace"` remained the only practicable way
 * out. This is the root cause of the defect `isolation.ts` fixes on the
 * other side: hardening the rule without making the worktree habitable would
 * only have moved the workaround one notch over.
 *
 * This module is the "Project Setup" step of the
 * `superpowers:using-git-worktrees` skill, applied to a third party rather
 * than to oneself: it is not the agent that sets up its workshop — it knows
 * neither its paths nor its commands —, it is the orchestrator that delivers
 * it fully set up, from what the project declared under `[worktree]`.
 *
 * Nothing here throws for an execution reason: a path that is absent,
 * tracked, not ignored or already present produces a **finding** the report
 * carries, not a failure. Only an invalid configuration throws — because it
 * is one.
 */
import { execFile } from "node:child_process";
import { access, cp, mkdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorktreeConfig } from "../config.js";

const execFileAsync = promisify(execFile);

/** How a path was placed into the worktree. */
export type MaterializeVia =
  /** Copy-on-write clone (APFS, Btrfs, XFS…): instant, isolated, no immediate disk cost. */
  | "clone"
  /** Plain recursive copy: isolated, but it costs its weight in time and bytes. */
  | "copy"
  /** Symbolic link: shared with the workspace, therefore **not** isolated. */
  | "link";

export interface MaterializedPath {
  path: string;
  via: MaterializeVia;
}

/** Why a declared path was not placed. Each of these reasons is benign — and each deserves to be said. */
export type SkipReason =
  /** The path does not exist in the workspace: nothing to place. */
  | "absent"
  /** Tracked by git: it is already in the worktree, with the right content. */
  | "tracked"
  /** Neither tracked nor ignored by git: placing it would pollute the diff that is the source of truth. */
  | "not-ignored"
  /** Already present in the worktree (placed by a setup command, or by git). */
  | "already-present";

export interface SkippedPath {
  path: string;
  reason: SkipReason;
  /** A ready-to-read sentence, saying why and — where applicable — what to do. */
  detail: string;
}

export interface MaterializeResult {
  materialized: MaterializedPath[];
  skipped: SkippedPath[];
  /**
   * The paths actually placed, to exclude from the task's diff: what the
   * orchestrator itself deposited is not the agent's work, and a copied
   * `.env` has no business in a `caesar apply`.
   */
  excluded: string[];
  /**
   * What is not isolated — the paths placed as links. Empty in the normal
   * case; non-empty, it is a finding the report must carry, because two
   * simultaneous tasks write there in the same place, and what they break
   * there, they break for the workspace.
   */
  shared: string[];
}

/**
 * Refuses a path that has no place in `[worktree]`. The configuration
 * schema (`WorktreePathSchema`) already applies these rules when the TOML
 * is loaded; repeating them here covers callers that build a
 * `WorktreeConfig` in memory, and makes the invariant a property of the
 * module rather than a property of the file.
 */
function assertRelativeInsidePath(path: string): void {
  if (path === "" || isAbsolute(path)) {
    throw new Error(`Path "${path}" in [worktree] is invalid: expected a path relative to the workspace root.`);
  }
  const segments = path.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Path "${path}" in [worktree] is invalid: a ".." segment would leave the workspace.`);
  }
  if (segments[0] === ".git" || segments[0] === ".caesar") {
    throw new Error(
      `Path "${path}" in [worktree] is invalid: ".git" and ".caesar" are the repository's administration and caesar's, ` +
        `the worktree exists precisely to leave them alone.`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True if git tracks at least one file under `path` (file or directory). */
async function isTracked(repo: string, path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "ls-files", "--", path]);
    return stdout.trim() !== "";
  } catch {
    return false;
  }
}

/** True if git ignores `path` (`.gitignore`, `.git/info/exclude`, global configuration). */
async function isIgnored(repo: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repo, "check-ignore", "-q", "--", path]);
    return true;
  } catch {
    // Exit code 1: not ignored. Any other code (128, outside a repository)
    // leads to the same cautious conclusion — we place nothing that we do
    // not know git will keep out of the diff.
    return false;
  }
}

/**
 * Copies `source` to `target`, favoring the filesystem's copy-on-write
 * clone, and returns the mechanism actually used.
 *
 * The clone duplicates no bytes as long as no one writes, which makes
 * copy-based isolation affordable where it would otherwise be
 * prohibitively expensive. It is not free either — the tree traversal
 * still has to happen. Measured on a 975 MB `node_modules` (~100,000
 * files, APFS): 6.3 s and 11 MB of disk, versus 15.0 s and 994 MB for a
 * plain copy. The clone remains a **real** copy from the agent's point of
 * view: two simultaneous tasks share nothing, and destroying the
 * worktree's `node_modules` does not touch the workspace's.
 *
 * `cp -c` (darwin) fails outright when the clonefile is impossible —
 * filesystem without copy-on-write, or crossing volumes — hence the
 * explicit fallback. On Linux, `--reflink=auto` falls back on its own to a
 * plain copy, but the two can then no longer be told apart: the `fs.cp`
 * fallback is used everywhere else, and its possible slowness is a fact
 * the report will state rather than a failure.
 */
async function copyTree(source: string, target: string): Promise<MaterializeVia> {
  if (process.platform === "darwin") {
    try {
      await execFileAsync("/bin/cp", ["-Rc", source, target]);
      return "clone";
    } catch {
      // No clonefile possible here: we copy for real.
    }
  } else if (process.platform === "linux") {
    try {
      await execFileAsync("cp", ["-R", "--reflink=auto", source, target]);
      // `auto` may have fallen back to a plain copy without saying so: we
      // therefore do not announce a clone that may not have happened.
      return "copy";
    } catch {
      // `cp` absent or refused: `fs.cp` below.
    }
  }
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  return "copy";
}

/**
 * Places into `worktree` the untracked paths that `request` declares,
 * taking them from `workspace`.
 *
 * The order of the checks, per path, is not indifferent:
 *
 * 1. **invalid path** ⇒ throws, it is a configuration error;
 * 2. **absent from the workspace** ⇒ skipped, there is nothing to place;
 * 3. **tracked by git** ⇒ skipped, and this is the most important one: the
 *    worktree already has its version, and placing a link on top would make
 *    the subagent write **into the main repository** — precisely the defect
 *    being fixed;
 * 4. **not ignored by git** ⇒ skipped: placing it would make it appear in
 *    `caesar diff`, which is the source of truth, and `worktreeHasChanges`
 *    would see the worktree dirty for life, so `caesar gc` would never clean
 *    it up;
 * 5. **already present in the worktree** ⇒ skipped, nothing is overwritten;
 * 6. otherwise **placed**, by clone, copy or link.
 *
 * `link` is processed after `copy`: if the same path appears in both, the
 * copy wins, since it isolates — and the link is then skipped as
 * `already-present`, which the report will say.
 */
export async function materializeUntracked(
  workspace: string,
  worktree: string,
  request: WorktreeConfig,
): Promise<MaterializeResult> {
  const materialized: MaterializedPath[] = [];
  const skipped: SkippedPath[] = [];
  const shared: string[] = [];

  const plan: { path: string; mode: "copy" | "link" }[] = [
    ...request.copy.map((path) => ({ path, mode: "copy" as const })),
    ...request.link.map((path) => ({ path, mode: "link" as const })),
  ];
  for (const entry of plan) assertRelativeInsidePath(entry.path);

  for (const { path, mode } of plan) {
    const from = join(workspace, path);
    const to = join(worktree, path);

    if (!(await exists(from))) {
      skipped.push({
        path,
        reason: "absent",
        detail: `"${path}" is declared under [worktree] but does not exist in the workspace: nothing to place.`,
      });
      continue;
    }
    if (await isTracked(workspace, path)) {
      skipped.push({
        path,
        reason: "tracked",
        detail:
          `"${path}" is tracked by git: the worktree already has its version. Placing it on top would make ` +
          `the subagent write into the main repository — remove it from [worktree].`,
      });
      continue;
    }
    if (!(await isIgnored(workspace, path))) {
      skipped.push({
        path,
        reason: "not-ignored",
        detail:
          `"${path}" is neither tracked nor ignored by git: placing it would make it appear in "caesar diff" as a ` +
          `change by the agent, and "caesar gc" would never clean up this worktree again. Add it to the .gitignore, ` +
          `or remove it from [worktree].`,
      });
      continue;
    }
    if (await exists(to)) {
      skipped.push({
        path,
        reason: "already-present",
        detail: `"${path}" is already present in the worktree: left as is, nothing is overwritten.`,
      });
      continue;
    }

    // The path may be nested (`packages/api/node_modules`) and its parent
    // only exists in the worktree if it carries tracked files.
    await mkdir(dirname(to), { recursive: true });

    if (mode === "link") {
      await symlink(resolve(from), to);
      materialized.push({ path, via: "link" });
      shared.push(path);
    } else {
      materialized.push({ path, via: await copyTree(from, to) });
    }
  }

  return { materialized, skipped, excluded: materialized.map((entry) => entry.path), shared };
}

export interface SetupFailure {
  command: string;
  exitCode: number | null;
  /** Standard output and error combined, truncated — pasted as-is into the failure reason. */
  output: string;
}

export interface SetupResult {
  /** The commands completed successfully, in order. */
  ran: string[];
  /** The first failing command, if there is one: the following ones were not launched. */
  failure?: SetupFailure;
}

/** Beyond this, a setup command's output stops helping to understand the failure. */
const SETUP_OUTPUT_LIMIT = 4000;

function tail(text: string): string {
  return text.length <= SETUP_OUTPUT_LIMIT ? text : `…\n${text.slice(-SETUP_OUTPUT_LIMIT)}`;
}

/**
 * Runs the `[worktree] setup` commands in the worktree, in order, and stops
 * at the first one that fails.
 *
 * Through a shell, not through argument splitting: what projects write here
 * looks like `npm ci && npm run build`, with redirections and chaining. It
 * is the same trust level as `[[agent]] bin`, which the orchestrator
 * already executes — a project's configuration is code its author chooses
 * to run on their own machine.
 *
 * The failure is not caught here: the caller decides that a task whose
 * workshop could not be set up must not start. Better not to start than to
 * hand the agent a half-set-up workshop, where it would spend its budget
 * repairing an installation rather than doing its work.
 */
export async function runSetup(worktree: string, commands: readonly string[], signal?: AbortSignal): Promise<SetupResult> {
  const ran: string[] = [];
  for (const command of commands) {
    try {
      await execFileAsync(shellBin(), [...shellArgs(), command], {
        cwd: worktree,
        ...(signal ? { signal } : {}),
        maxBuffer: 16 * 1024 * 1024,
      });
      ran.push(command);
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      const output = tail([failure.stdout ?? "", failure.stderr ?? ""].filter(Boolean).join("\n").trim() || (failure.message ?? ""));
      return { ran, failure: { command, exitCode: typeof failure.code === "number" ? failure.code : null, output } };
    }
  }
  return { ran };
}

function shellBin(): string {
  return process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : "/bin/sh";
}

function shellArgs(): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
}

/**
 * What a project reveals of its workshop needs: per recognized marker, the
 * paths to bring along and the usual install command.
 *
 * Deliberately short and conventional. An exhaustive detection would be
 * wrong more often than it would help — and a `[worktree]` written once by
 * `caesar init` gets re-read and corrected by hand, which is true of no
 * heuristic applied on every run.
 */
const PROJECT_MARKERS: { marker: string; copy: string[]; setup?: string }[] = [
  { marker: "pnpm-lock.yaml", copy: ["node_modules"], setup: "pnpm install --frozen-lockfile --prefer-offline" },
  { marker: "yarn.lock", copy: ["node_modules"], setup: "yarn install --immutable" },
  { marker: "package-lock.json", copy: ["node_modules"], setup: "npm ci" },
  { marker: "package.json", copy: ["node_modules"], setup: "npm install" },
  { marker: "Cargo.toml", copy: ["target"] },
  { marker: "poetry.lock", copy: [".venv"], setup: "poetry install" },
  { marker: "pyproject.toml", copy: [".venv"] },
  { marker: "requirements.txt", copy: [".venv"] },
  { marker: "go.mod", copy: [] },
];

/** Common unversioned paths, unrelated to any ecosystem: brought along if they exist and are ignored. */
const COMMON_UNTRACKED = [".env", ".env.local"];

/**
 * Guesses what a project's worktree should bring along, so that `caesar init`
 * writes an already-useful `[worktree]` rather than an empty section to fill
 * in.
 *
 * Proposes **only** what actually exists in the workspace and what git
 * ignores: proposing a tracked path would reopen the defect that
 * `materializeUntracked` refuses (the agent would write into the main
 * repository), and proposing a path neither tracked nor ignored would
 * pollute the diff. The detection therefore applies, upstream, exactly the
 * same rules as the placement.
 *
 * A bare project produces nothing at all — `caesar init` then writes no
 * section, rather than an empty section that would suggest a setting.
 * `setup` is the only field the detection can propose wrongly: an install
 * command is a convention, not a fact, and it is on that account that it is
 * written in plain text in the file, where it can be corrected.
 */
export async function detectUntrackedNeeds(workspace: string): Promise<WorktreeConfig | null> {
  const copy: string[] = [];
  const setup: string[] = [];

  for (const { marker, copy: paths, setup: command } of PROJECT_MARKERS) {
    if (!(await exists(join(workspace, marker)))) continue;
    for (const path of paths) {
      if (!copy.includes(path) && (await isUsableUntracked(workspace, path))) copy.push(path);
    }
    if (command && !setup.includes(command)) setup.push(command);
    // A single ecosystem per family: markers are ordered from most specific
    // to most general (`pnpm-lock.yaml` before `package.json`), and the
    // first one found fixes the command. Without this exit, a pnpm project
    // would also receive `npm install`.
    if (command) break;
  }

  // After the loop: these depend on no ecosystem.
  for (const path of COMMON_UNTRACKED) {
    if (!copy.includes(path) && (await isUsableUntracked(workspace, path))) copy.push(path);
  }

  if (copy.length === 0 && setup.length === 0) return null;
  return { copy, link: [], setup };
}

/** Exists, is not tracked, and git ignores it — the three conditions `materializeUntracked` will require. */
async function isUsableUntracked(workspace: string, path: string): Promise<boolean> {
  if (!(await exists(join(workspace, path)))) return false;
  if (await isTracked(workspace, path)) return false;
  return isIgnored(workspace, path);
}

/**
 * True if `path` is under `prefix` (or is exactly it), in path segments —
 * never as a plain string comparison, which would make `node_modules-old`
 * pass for a child of `node_modules`.
 *
 * Used to remove from the diff what the materialization placed: a placed
 * directory excludes everything it contains.
 */
export function isUnderPath(path: string, prefix: string): boolean {
  const normalized = path.split(/[\\/]/).join(sep);
  const base = prefix.split(/[\\/]/).join(sep);
  return normalized === base || normalized.startsWith(base + sep);
}
