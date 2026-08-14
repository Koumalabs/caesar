/**
 * Isolation of a write task: under what conditions a sub-agent has the
 * right to write directly into the user's repository, rather than into a
 * disposable worktree.
 *
 * The defect this module exists to fix: the resolution chain
 * (`delegation.ts`) granted an explicit request the last word over the
 * role and over the policy, and `prepareIsolation` (`engine/runner.ts`)
 * honored it as-is — no warning, no finding in the report.
 * An `isolation: "inplace"` passed to `caesar_delegate` therefore silently
 * undid the `implementer` role, which nevertheless mandates `worktree`. Observed on
 * a real repository: three delegated tasks wrote directly onto the user's working
 * branch, and nothing in their report said so.
 *
 * The existing safeguard, `mustForceWorktree`, only covers read-only mode:
 * it forces the worktree so that a forbidden write is *contained and
 * detected*. Here the question is the reverse — the write is allowed, it is
 * its *location* that commits someone else's repository — and the answer must
 * be too: we refuse instead of redirecting. Silently redirecting
 * an agent's write to an elsewhere the caller did not ask for would be
 * worse than refusing: they would expect their modifications in their working
 * tree and would not find them there.
 *
 * Like `policy.ts` and `network.ts`, this module does no I/O: it decides,
 * and every refusal carries a reason and a remedy written for a human — a
 * bare refusal would bubble up as-is to the main agent via MCP, where it
 * would be unusable.
 */
import type { Isolation, TaskMode } from "@caesar/protocol";

/**
 * Where the selected isolation comes from, along the
 * `explicit argument > role > policy` chain of `resolveDelegation`.
 *
 * Plays no part in the decision — only in its wording. A refusal whose
 * reason says "explicitly requested" when the value came from the policy
 * default would send the user off to fix the wrong file.
 */
export type IsolationSource = "explicit" | "role" | "policy";

export interface InplaceWriteQuery {
  /** The isolation selected by the resolution chain, `"auto"` included. */
  requested: Isolation | "auto";
  mode: TaskMode;
  /**
   * True only if the workspace is in a git repository **bearing at least one
   * commit** — that is, if a worktree is actually creatable there (see
   * `usableRepoRoot`). A repository without a commit has no `HEAD` to start from.
   */
  repoUsable: boolean;
  /** The `policy.allow_inplace_write` opt-in, as the caller passed it along. */
  allowed: boolean;
  source?: IsolationSource;
  /** Root of the repository concerned, so the reason names what is protected. */
  repo?: string;
  /** Role name, when `source` is `"role"`. */
  roleName?: string;
}

export type InplaceWriteDecision =
  | { refused: false }
  | { refused: true; reason: string; remedy: string };

/** "explicitly requested", "inherited from role \"implementer\"", … */
function describeSource(source: IsolationSource | undefined, roleName?: string): string {
  switch (source) {
    case "explicit":
      return "explicitly requested";
    case "role":
      return roleName ? `inherited from role "${roleName}"` : "inherited from the role";
    case "policy":
      return 'inherited from the policy default ("default_isolation")';
    default:
      return "selected";
  }
}

/**
 * Decides whether a task has the right to run in `"inplace"` isolation.
 *
 * Refuses **if and only if** the four conditions come together:
 * `"inplace"` explicitly selected, write mode, usable git repository, and
 * opt-in absent. Each deserves to be read as a guard:
 *
 * - `requested === "inplace"`: `"auto"` is not concerned, it is
 *   `prepareIsolation` that chooses for it — and it already chooses the
 *   worktree in write mode whenever it can.
 * - `mode === "write"`: read-only mode falls under `mustForceWorktree`, whose
 *   logic is the opposite (contain, not forbid).
 * - `repoUsable`: without a usable repository, no worktree is possible.
 *   Refusing here would make `caesar` unusable on any unversioned or
 *   freshly initialized project — a hardening that breaks the ordinary case
 *   is not a hardening, it is an outage. `prepareIsolation` already warns for
 *   that case.
 * - `!allowed`: the `policy.allow_inplace_write` opt-in exists for repositories
 *   where the user knowingly assumes the risk.
 *
 * The function is called twice on the same path — early in
 * `resolveDelegation`, to refuse before any task directory gets
 * written to disk, and again in `prepareIsolation`, the only point that
 * *all* the facades pass through, including a direct call to `runTask`. It
 * is pure: both calls necessarily return the same verdict.
 */
export function decideInplaceWrite(query: InplaceWriteQuery): InplaceWriteDecision {
  const { requested, mode, repoUsable, allowed } = query;

  if (requested !== "inplace" || mode !== "write" || !repoUsable || allowed) {
    return { refused: false };
  }

  const where = query.repo ? ` of the repository "${query.repo}"` : "";
  return {
    refused: true,
    reason:
      `Isolation "inplace" ${describeSource(query.source, query.roleName)} for a write task: refused. ` +
      `The sub-agent would write directly into the working tree${where}, on the current branch — ` +
      `its modifications would mingle with yours and with those of the other tasks, without "caesar diff" being able to account for them.`,
    remedy:
      `Leave the isolation at "worktree" (or "auto"): the sub-agent then works on a disposable branch, ` +
      `whose result "caesar diff" shows and "caesar apply" carries over. If the worktree is unusable because it is ` +
      `missing files not tracked by git (installed dependencies, ".env", ignored briefs), declare them under ` +
      `[worktree] in ".caesar/config.toml" (keys "copy", "link", "setup") rather than giving up on isolation. ` +
      `As a last resort, and knowingly, set "allow_inplace_write = true" under [policy].`,
  };
}
