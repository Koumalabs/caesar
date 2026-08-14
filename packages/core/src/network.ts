/**
 * Network access of a delegated task: what the caller requests, what the
 * orchestrator actually knows how to obtain from the chosen agent, and what
 * must be said about it when the two do not coincide.
 *
 * The defect this module exists to fix: the five agents did not
 * behave the same way and nothing said so. `codex exec` runs
 * in a sandbox whose network is cut off — a task "install X" failed there
 * with no explanation — while `claude`, `agy` and `opencode`, to whom
 * our adapters pass no confinement, had it open. The same
 * mission passed on one and failed on the other.
 *
 * Like `policy.ts`, this module does no I/O: it decides, and every
 * decision carries a sentence written for a human. A refusal without a
 * reason would bubble up as-is to the main agent via MCP, where it would be
 * unusable.
 */
import type { TaskMode } from "@caesar/protocol";

/**
 * What the caller requests — policy, role or task. Same tri-state form
 * as `isolation`.
 *
 * The list is here, and only once: the configuration's zod schema
 * (`config.ts`) and the validation of the `--network` flag (`packages/cli`)
 * both derive from it, rather than each copying it on their own side — the
 * defect `flags.ts` already documents for `--mode` and `--isolation`.
 */
export const NETWORK_REQUESTS = ["auto", "on", "off"] as const;
export type NetworkRequest = (typeof NETWORK_REQUESTS)[number];

/**
 * What the orchestrator knows how to **control** in an agent — not what the
 * agent can do. The distinction carries the whole module: `open` does not
 * mean "this agent has the network", but "we have no way to take it
 * away from it", which forbids making it a guarantee.
 */
export type NetworkControl =
  /** No confinement passed by our adapter: the network is open, we do not know how to close it. */
  | "open"
  /** We know how to open it, in both modes. */
  | "toggle"
  /** We know how to open it, but only in write mode — the `codex` case. */
  | "write-only"
  /** We know nothing about this agent's network: a declared agent that announces no network arguments. */
  | "unknown";

/**
 * `available` is the task's truth, as far as we can
 * assert it: it is what gets written on the `Task` and read by the brief.
 * It is not "we pass the opening flag" — for an `open` agent
 * it is true without any argument being added.
 *
 * The adapters, for their part, need nothing more: when they receive
 * `available` as true, they add their flag if and only if they have
 * one. A `write-only` agent cannot receive it in read-only mode, the
 * decision having already brought it back to false.
 */
export type NetworkDecision =
  | { refused: false; available: boolean; warning?: string }
  | { refused: true; reason: string; remedy: string };

export interface NetworkQuery {
  agentId: string;
  requested: NetworkRequest;
  mode: TaskMode;
  control: NetworkControl;
}

/**
 * Why a `write-only` agent can do nothing for a read-only task,
 * and which way out. Verified on codex 0.147.0: its sandbox exposes
 * `sandbox_workspace_write.network_access`, and there is no
 * `sandbox_read_only` — under `-s read-only`, the network is cut off with no recourse.
 */
function writeOnlyRemedy(): string {
  return (
    `Relaunch in write mode — "--mode write --isolation worktree" confines the modifications to a disposable branch, ` +
    `inspectable afterwards with "caesar diff" — or choose an agent whose network is already open (antigravity, opencode).`
  );
}

/**
 * Resolves the network request against what the chosen agent allows.
 *
 * The rule that governs the edge cases: never let a guarantee be believed
 * that does not exist. An `off` requested from an agent we do not know
 * how to confine does not fail — it runs, but the report says the
 * closure did not happen. It is the same honesty as `describeAgentPolicy`
 * (policy.ts), which refuses to suggest an ineffective remedy.
 *
 * `auto` (the default) and `on` differ on one point only, and it is the point
 * that matters: `auto` opens wherever possible and settles for
 * warning elsewhere, while `on` refuses the delegation. Without that
 * distinction, an `on` set as default would fail *every* read-only
 * task on codex — the `reviewer` and `investigator` roles shipped by
 * default would stop working.
 */
export function decideNetwork(query: NetworkQuery): NetworkDecision {
  const { agentId, requested, mode, control } = query;

  if (requested === "off") {
    // `open` and `unknown`: the network stays open (or in an unknown state)
    // no matter what. Say it, rather than returning an `available: false`
    // that would describe a closure that did not happen — and that the brief
    // would relay to the agent as a lying constraint.
    if (control === "open" || control === "unknown") {
      return {
        refused: false,
        available: true,
        warning:
          `Network requested closed, but the orchestrator does not know how to close it for "${agentId}": ` +
          `the task runs with the network as the agent's CLI leaves it.`,
      };
    }
    return { refused: false, available: false };
  }

  switch (control) {
    case "open":
    case "toggle":
      return { refused: false, available: true };

    case "write-only":
      if (mode === "write") return { refused: false, available: true };
      if (requested === "on") {
        return {
          refused: true,
          reason: `Agent "${agentId}" can only open the network in write mode: its read-only sandbox cuts it off with no recourse.`,
          remedy: writeOnlyRemedy(),
        };
      }
      // `auto`: the task goes out anyway, without network, but the report
      // says so. It is the common case (the `reviewer` and `investigator`
      // roles on codex); declaring `network = "off"` on the role makes the
      // intention explicit and silences the warning.
      return {
        refused: false,
        available: false,
        warning:
          `Network unavailable: "${agentId}" can only open it in write mode. ${writeOnlyRemedy()}`,
      };

    case "unknown":
      // Under `auto`, the caller expressed nothing: there is nothing to fix,
      // so nothing to say. Under `on`, they expect a guarantee we do not
      // have — that is where the warning earns its place.
      if (requested === "on") {
        return {
          refused: false,
          available: true,
          warning:
            `Network requested, but the orchestrator does not control "${agentId}"'s network: ` +
            `declare "network_args" on this agent so it knows how to open it explicitly.`,
        };
      }
      return { refused: false, available: true };
  }
}

/** Short label of a network capability, for `caesar doctor` and the Agents screen. */
export function describeNetworkControl(control: NetworkControl): string {
  switch (control) {
    case "open":
      return "network open";
    case "toggle":
      return "network controllable";
    case "write-only":
      return "network write-only";
    case "unknown":
      return "network unknown";
  }
}
