/**
 * Roles: what each sub-agent is for, and which agent to select for a given
 * role once fallback (preferred agent unavailable or refused) is taken
 * into account.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaesarConfig, PolicyConfig, RoleConfig } from "./config.js";
import { isEnoent } from "./config.js";
import { isAgentAllowed, isRecursionAllowed } from "./policy.js";
import { findAgentDefinition, findBinaryInPath } from "./registry/index.js";
import type { GenericAgentSpec } from "./registry/generic.js";

export interface ResolvedRole extends RoleConfig {
  systemPrompt: string;
}

/**
 * Where a `system_prompt_file` is actually read: under `<root>/.caesar/`,
 * always — including when the role comes from the global layer, whose
 * paths are therefore resolved in the current project (known limitation,
 * not a decision of this function).
 *
 * Exported so that the interfaces that *write* this file — the TUI's
 * prompt editor — target exactly the file `resolveRole` will read. Without
 * it, each would recompose the path on its own, and one day not at the
 * same place: the edited prompt would then no longer be the one passed to
 * the agent, with nothing signaling it.
 */
export function rolePromptPath(root: string, systemPromptFile: string): string {
  return join(root, ".caesar", systemPromptFile);
}

/**
 * Resolves a role by name and loads its system prompt. `null` if no role
 * of that name exists. `system_prompt_file` is resolved relative to
 * `<root>/.caesar/` (`rolePromptPath`); a missing file is not an
 * error, `systemPrompt` is simply the empty string — a role without a
 * system prompt remains perfectly usable.
 */
export async function resolveRole(config: CaesarConfig, root: string, name: string): Promise<ResolvedRole | null> {
  const role = config.roles.find((candidate) => candidate.name === name);
  if (!role) return null;

  let systemPrompt = "";
  if (role.system_prompt_file) {
    const path = rolePromptPath(root, role.system_prompt_file);
    try {
      systemPrompt = await readFile(path, "utf8");
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error(
          `Cannot read the system prompt of role "${name}" (${path}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { ...role, systemPrompt };
}

/**
 * Resolves, for a set of agent identifiers, whether each one is installed
 * (binary found on the `PATH`) — the synchronous predicate expected by
 * `pickAgentForRole`, precomputed once and for all. Shared by
 * `resolveDelegation` (below, one role at a time) and by `caesar role list`
 * (`packages/cli/src/commands/role.ts`, all roles at once): the two
 * facades used to resolve this same map each on their own side (task
 * 10, B).
 *
 * `extraAgents` (configuration agents, `CaesarConfig.agents`) lets
 * `role.agents` name a generic agent, not only the native catalog —
 * see C1 of the final review.
 */
export async function resolveInstalledMap(
  agentIds: Iterable<string>,
  extraAgents: readonly GenericAgentSpec[] = [],
): Promise<Map<string, boolean>> {
  const entries = await Promise.all(
    [...new Set(agentIds)].map(async (id): Promise<[string, boolean]> => {
      const def = findAgentDefinition(id, extraAgents);
      if (!def) return [id, false];
      return [id, (await findBinaryInPath(def.bin)) !== null];
    }),
  );
  return new Map(entries);
}

export interface AgentPick {
  agentId: string;
  skipped: Array<{ agentId: string; reason: string }>;
}

/**
 * Walks `role.agents` in order and selects the first agent both installed
 * and allowed by the policy. Every agent set aside is kept in `skipped`
 * with a self-contained reason (it names the agent, not just the cause):
 * that is what makes the fallback diagnosable, the very point of this
 * function.
 *
 * Delegation depth plays no part here — it only makes sense for an
 * in-flight task (`checkDelegation`, called by the engine with a real
 * depth) and not for the mere selection of a candidate agent.
 * The two other dimensions of the policy (allowed/denied lists,
 * recursion) do apply in full, however.
 */
export function pickAgentForRole(
  role: RoleConfig,
  options: { isInstalled: (agentId: string) => boolean; policy: PolicyConfig },
): AgentPick | { error: string } {
  const skipped: Array<{ agentId: string; reason: string }> = [];

  for (const agentId of role.agents) {
    if (!options.isInstalled(agentId)) {
      skipped.push({ agentId, reason: `Agent "${agentId}" not installed: binary not found in the PATH.` });
      continue;
    }

    const allowedDecision = isAgentAllowed(options.policy, agentId);
    if (!allowedDecision.allowed) {
      skipped.push({ agentId, reason: allowedDecision.reason });
      continue;
    }

    const recursionDecision = isRecursionAllowed(options.policy, agentId);
    if (!recursionDecision.allowed) {
      skipped.push({ agentId, reason: recursionDecision.reason });
      continue;
    }

    return { agentId, skipped };
  }

  if (role.agents.length === 0) {
    return { error: `No candidate agent for role "${role.name}": the role's "agents" list is empty.` };
  }
  return {
    error: `No agent available for role "${role.name}": ${skipped.map((entry) => entry.reason).join(" ; ")}`,
  };
}
