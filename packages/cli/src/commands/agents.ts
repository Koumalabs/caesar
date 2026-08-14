/**
 * `caesar agents list|enable|disable|test`.
 *
 * `describeAgentCapabilities`/`describeAgentPolicy` live in `@caesar/core`
 * (`registry/index.ts`, `policy.ts`) since the task 8 correction report —
 * `packages/tui` needed them for its Agents screen, and duplicating them
 * there or making the TUI depend on the CLI for two pure functions was
 * worse than moving them next to what they describe. This module now merely
 * calls them, like `doctor.ts`.
 *
 * `enable`/`disable` write a single layer (`--global`/`--local`, project by
 * default) via `materializePolicyList` (`@caesar/core`, same mechanism as
 * `caesar policy allow|deny` — "denied" is the same field): never the merge,
 * see the task 13 brief.
 */
import type { ConfigScope, GenericAgentSpec } from "@caesar/core";
import {
  AGENT_DEFINITIONS,
  GENERIC_ARG_TOKENS,
  agentProvenance,
  checkDelegation,
  createSlotQueue,
  describeAgentCapabilities,
  describeAgentCapabilitiesShort,
  describeAgentPolicy,
  fileTaskStore,
  findAgentDefinition,
  findBinaryInPath,
  listAgentDefinitions,
  loadConfig,
  loadLayer,
  materializePolicyList,
  runTask,
  saveLayer,
  splitArgTemplate,
  validateGenericAgentSpec,
} from "@caesar/core";
import type { Cell, Io } from "../output.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  homePath,
  printDone,
  printError,
  printHeading,
  printJson,
  printNote,
  printTable,
  sectionHeader,
  terminalWidth,
  wrapText,
  writeLine,
} from "../output.js";
import type { ScopeOptions } from "../scope.js";
import { materializationNotice, resolveScope, scopeFlagHint, scopeLabel } from "../scope.js";

export interface AgentsListOptions {
  json?: boolean;
}

export async function runAgentsList(root: string, options: AgentsListOptions, io: Io): Promise<number> {
  const { config, layers } = await loadConfig(root);
  // Native catalog extended with the configuration's agents ([[agent]]): see
  // C1 of the final review — without which an agent declared in TOML stayed
  // invisible to "caesar agents list".
  const defs = listAgentDefinitions(config.agents);

  const rows = await Promise.all(
    defs.map(async (def) => {
      const path = await findBinaryInPath(def.bin);
      return {
        id: def.id,
        display_name: def.displayName,
        bin: def.bin,
        installed: path !== null,
        path: path ?? undefined,
        capabilities: describeAgentCapabilities(def),
        // For formatting only: `capabilities` remains what `--json`
        // publishes, spelled out and unchanged.
        capabilitiesShort: describeAgentCapabilitiesShort(def),
        policy: describeAgentPolicy(config.policy, def.id),
        // "default" for the five agents of the native catalog: no layer declares them, they are wired into the registry.
        provenance: agentProvenance(layers, def.id),
      };
    }),
  );

  if (options.json) {
    printJson(io, { agents: rows });
    return EXIT_OK;
  }

  sectionHeader(io, "agents");

  // The reason for a denial is a full sentence: in a cell, it trimmed the
  // "policy" column down to "denied (Agent "c…" — hence to nothing. It goes
  // below the table, where it has room to be read, as `caesar doctor`
  // already does.
  const tableRows: Cell[][] = rows.map((r) => [
    r.id,
    r.installed ? homePath(r.path ?? "found") : { text: "missing", token: "bad" },
    { text: r.capabilitiesShort.join(" ") || "-", token: "dim" },
    r.policy.allowed ? { text: "allowed", token: "ok" } : { text: "denied", token: "bad" },
    { text: r.provenance, token: "dim" },
  ]);
  printTable(io, ["agent", "binary", "capabilities", "policy", "provenance"], tableRows);

  const denied = rows.filter((r) => !r.policy.allowed);
  if (denied.length > 0) {
    writeLine(io.stdout);
    printHeading(io, "denials");
    for (const r of denied) {
      if (r.policy.allowed) continue;
      for (const line of wrapText(`"${r.id}": ${r.policy.reason}`, terminalWidth(io.stdout), "  - ", "    ")) {
        writeLine(io.stdout, line);
      }
    }
  }
  writeLine(io.stdout);
  for (const line of wrapText(
    'Capabilities spelled out: "caesar doctor --verbose", or "caesar agents list --json".',
    terminalWidth(io.stdout),
  )) {
    printNote(io, line);
  }
  return EXIT_OK;
}

export interface AgentsToggleOptions extends ScopeOptions {
  json?: boolean;
}

async function setAgentDenied(
  root: string,
  id: string,
  denied: boolean,
  options: AgentsToggleOptions,
): Promise<{ scope: ConfigScope; effective: string[]; materialized: boolean } | { error: string }> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") return scope;
  const { effective, materialized } = await materializePolicyList(root, scope, "denied", id, denied);
  return { scope, effective, materialized };
}

function reportToggle(
  io: Io,
  options: AgentsToggleOptions,
  id: string,
  enabled: boolean,
  scope: ConfigScope,
  denied: string[],
  materialized: boolean,
): number {
  if (options.json) {
    printJson(io, { id, enabled, scope, denied, materialized });
  } else {
    printDone(
      io,
      enabled
        ? `Agent "${id}" removed from the "denied" list (${scopeLabel(scope)} layer).`
        : `Agent "${id}" added to the "denied" list (${scopeLabel(scope)} layer).`,
    );
    if (materialized) printNote(io, materializationNotice("denied", scope, denied));
  }
  return EXIT_OK;
}

export async function runAgentsEnable(root: string, id: string, options: AgentsToggleOptions, io: Io): Promise<number> {
  const result = await setAgentDenied(root, id, false, options);
  if ("error" in result) {
    printError(io, result.error);
    return EXIT_USAGE;
  }
  return reportToggle(io, options, id, true, result.scope, result.effective, result.materialized);
}

export async function runAgentsDisable(root: string, id: string, options: AgentsToggleOptions, io: Io): Promise<number> {
  const result = await setAgentDenied(root, id, true, options);
  if ("error" in result) {
    printError(io, result.error);
    return EXIT_USAGE;
  }
  return reportToggle(io, options, id, false, result.scope, result.effective, result.materialized);
}

// ---------------------------------------------------------------------------
// Declaring an agent (`[[agent]]`)
// ---------------------------------------------------------------------------

/**
 * The five agents wired into the registry. Declaring an `[[agent]]` entry
 * carrying one of these identifiers is legitimate — `listAgentDefinitions`
 * lets the configuration win over the native one, deliberately — but heavy
 * enough in consequences (the native adapter, its capabilities and its
 * event translation disappear in favor of a generic launch) to be flagged
 * rather than endured.
 */
const NATIVE_IDS = new Set(AGENT_DEFINITIONS.map((def) => def.id));

/** Reminder of the substitutable tokens — the `--args` help quotes it (see `program.ts`), rather than a second hand-written list. */
export const ARG_TOKENS_HINT = GENERIC_ARG_TOKENS.map((name) => `{{${name}}}`).join(", ");

export interface AgentsAddOptions extends ScopeOptions {
  bin?: string;
  args?: string;
  displayName?: string;
  cwdMode?: string;
  readOnlyNative?: boolean;
  json?: boolean;
}

export async function runAgentsAdd(root: string, id: string, options: AgentsAddOptions, io: Io): Promise<number> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") {
    printError(io, scope.error);
    return EXIT_USAGE;
  }

  const bin = options.bin?.trim();
  if (!bin) {
    printError(io, 'Specify --bin <command>: the binary to launch for this agent (for example --bin aider).');
    return EXIT_USAGE;
  }

  const cwdMode = options.cwdMode ?? "process";
  if (cwdMode !== "process" && cwdMode !== "flag") {
    printError(io, 'Invalid --cwd-mode (expected "process" — the current directory carries the workspace — or "flag" — the workspace is already passed as an argument).');
    return EXIT_USAGE;
  }

  let args: string[];
  try {
    args = splitArgTemplate(options.args ?? "{{prompt}}");
  } catch (error) {
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  const spec: GenericAgentSpec = { id, bin, args, cwdMode };
  if (options.displayName !== undefined) spec.displayName = options.displayName;
  if (options.readOnlyNative) spec.capabilities = { nativeReadOnly: true };

  const invalid = validateGenericAgentSpec(spec);
  if (invalid) {
    printError(io, invalid);
    return EXIT_USAGE;
  }

  const layer = await loadLayer(scope, root);
  const replaced = layer.agents?.some((agent) => agent.id === id) ?? false;
  const agents = [...(layer.agents ?? []).filter((agent) => agent.id !== id), spec];
  await saveLayer(scope, root, { ...layer, agents });

  // Installation check *after* the write, and never blocking: declaring an
  // agent not yet installed is legitimate (a machine, a shared
  // configuration file), but learning about it on the first `caesar run` is
  // not.
  const binPath = await findBinaryInPath(bin);

  if (options.json) {
    printJson(io, { agent: spec, replaced, scope, bin_path: binPath, overrides_native: NATIVE_IDS.has(id) });
    return EXIT_OK;
  }

  printDone(io, `Agent "${id}" ${replaced ? "replaced" : "declared"} (${scopeLabel(scope)} layer).`);
  printNote(io, `  Command line: ${bin} ${args.join(" ")}`);
  if (NATIVE_IDS.has(id)) {
    writeLine(
      io.stdout,
      `Warning: "${id}" is an agent of the native catalog. This declaration replaces it — its adapter, its capabilities and its event translation no longer apply. To merely allow or deny it, "caesar agents disable ${id}".`,
    );
  }
  if (binPath === null) {
    // The PATH is only consulted for a bare name: an explicit path
    // designates a file (see `findBinaryInPath`), and saying "not found in
    // the PATH" would then send people looking in the wrong place.
    const why = bin.includes("/")
      ? `does not exist or is not executable`
      : `is not found in the PATH`;
    writeLine(io.stdout, `The binary "${bin}" ${why}: the declaration is recorded, but the agent will not be picked until it is.`);
  }
  return EXIT_OK;
}

export interface AgentsRemoveOptions extends ScopeOptions {
  json?: boolean;
}

export async function runAgentsRemove(root: string, id: string, options: AgentsRemoveOptions, io: Io): Promise<number> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") {
    printError(io, scope.error);
    return EXIT_USAGE;
  }

  const layer = await loadLayer(scope, root);
  if (!layer.agents?.some((agent) => agent.id === id)) {
    // Same limit as `caesar role remove`: keyed merging (`mergeConfig`)
    // replaces, it never deletes by absence. Removing an entry from a layer
    // that does not declare it would not make it disappear from the merge —
    // an EXIT_OK would lie about what just happened.
    const { layers } = await loadConfig(root);
    const actual = agentProvenance(layers, id);
    if (actual === "default") {
      const hint = NATIVE_IDS.has(id)
        ? `it belongs to the native catalog: no layer declares it, and nothing removes it. To keep it out of delegations, "caesar agents disable ${id}".`
        : `no layer declares it: check the identifier with "caesar agents list".`;
      printError(io, `Nothing to remove for agent "${id}": ${hint}`);
    } else {
      printError(
        io,
        `Agent "${id}" is not declared by the ${scopeLabel(scope)} layer: nothing to remove here, it comes from the ${scopeLabel(actual)} layer — retry with ${scopeFlagHint(actual)}.`,
      );
    }
    return EXIT_USAGE;
  }

  const agents = layer.agents.filter((agent) => agent.id !== id);
  await saveLayer(scope, root, { ...layer, agents });

  if (options.json) {
    printJson(io, { id, removed: true, scope, restores_native: NATIVE_IDS.has(id) });
    return EXIT_OK;
  }
  printDone(io, `Agent "${id}" removed (${scopeLabel(scope)} layer).`);
  if (NATIVE_IDS.has(id)) printNote(io, `  The native "${id}" adapter takes over again.`);
  return EXIT_OK;
}

export interface AgentsTestOptions {
  yes?: boolean;
  json?: boolean;
}

/** Read-only micro-task, used to check that an agent actually responds. */
const PING_OBJECTIVE = "Reply with only: OK";

export async function runAgentsTest(root: string, id: string, options: AgentsTestOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  if (!findAgentDefinition(id, config.agents)) {
    printError(io, `Unknown agent: "${id}".`);
    return EXIT_USAGE;
  }
  if (!options.yes) {
    printError(
      io,
      `"caesar agents test" launches a real task and consumes the real quota of agent "${id}". Add --yes to confirm.`,
    );
    return EXIT_USAGE;
  }

  const decision = checkDelegation(config.policy, { agentId: id, depth: 0 });
  if (!decision.allowed) {
    printError(io, decision.reason);
    return EXIT_USAGE;
  }

  const store = fileTaskStore(root);
  // Same lock as `caesar run`: this probe launches a real agent, so it
  // counts against `max_parallel` like any delegation.
  const queue = createSlotQueue({ root, limit: config.policy.max_parallel, label: `caesar agents test ${id}` });
  const startedAt = Date.now();
  const outcome = await runTask(
    { store, root, queue },
    {
      agentId: id,
      objective: PING_OBJECTIVE,
      mode: "read-only",
      // "auto" rather than hardcoded "inplace": the probe has no reason to
      // impose an execution location, and doing so bypassed the isolation
      // rule for the only command that launches an agent without going
      // through `resolveDelegation`. The result is the same as before for
      // natively read-only agents; for the others, `runTask` isolates the
      // probe as it isolates any read-only task.
      isolation: "auto",
      allowInplaceWrite: config.policy.allow_inplace_write,
      workspace: root,
      timeoutMs: 60_000,
      extraAgents: config.agents,
      worktreeSetup: config.worktree,
    },
  );
  const durationMs = Date.now() - startedAt;
  const responded = outcome.source !== "synthesized";

  if (options.json) {
    printJson(io, {
      agent: id,
      responded,
      duration_ms: durationMs,
      report_source: outcome.source,
      status: outcome.record.status,
      summary: outcome.report.summary,
    });
  } else if (responded) {
    writeLine(
      io.stdout,
      `Agent "${id}" responded in ${durationMs} ms (report recovered at the "${outcome.source}" tier). Summary: ${outcome.report.summary}`,
    );
  } else {
    printError(
      io,
      `Agent "${id}" produced no usable report in ${durationMs} ms (report synthesized by default).`,
    );
  }

  return outcome.record.status === "succeeded" ? EXIT_OK : EXIT_RUNTIME;
}
