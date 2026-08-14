/**
 * `caesar doctor`: installation diagnosis. One line per agent of the
 * catalog — presence, version, capabilities, status with respect to the
 * policy — followed by what is missing and how to remedy it.
 *
 * The table is compact by default: the capabilities enumerated in full,
 * plus the binary path, exceeded a terminal's width and wrapped onto the
 * next line, making unreadable the overview this command exists to give.
 * `--verbose` restores the detail for whoever looks for it.
 */
import {
  describeAgentCapabilities,
  describeAgentCapabilitiesShort,
  describeAgentPolicy,
  detectAgentInstallation,
  listAgentDefinitions,
  loadConfig,
  policyFieldProvenance,
  remedyFor,
} from "@caesar/core";
import type { Cell, Io } from "../output.js";
import {
  EXIT_OK,
  homePath,
  printDone,
  printHeading,
  printJson,
  printNote,
  printTable,
  sectionHeader,
  terminalWidth,
  wrapText,
  writeLine,
} from "../output.js";

export interface DoctorOptions {
  json?: boolean;
  verbose?: boolean;
}

export async function runDoctor(root: string, options: DoctorOptions, io: Io): Promise<number> {
  const { config, layers } = await loadConfig(root);
  // Native catalog extended with the configuration's agents ([[agent]]): see
  // C1 of the final review.
  const defs = listAgentDefinitions(config.agents);

  const rows = await Promise.all(
    defs.map(async (def) => {
      const status = await detectAgentInstallation(def);
      return {
        id: def.id,
        display_name: def.displayName,
        bin: def.bin,
        installed: status.installed,
        path: status.path,
        version: status.version,
        capabilities: describeAgentCapabilities(def),
        // For the compact layout only: `capabilities` remains what `--json`
        // publishes, unchanged.
        capabilitiesShort: describeAgentCapabilitiesShort(def),
        policy: describeAgentPolicy(config.policy, def.id),
      };
    }),
  );

  const missing = rows.filter((r) => !r.installed);
  const denied = rows.filter((r) => r.installed && !r.policy.allowed);

  if (options.json) {
    printJson(io, {
      agents: rows,
      missing: missing.map((r) => r.id),
      denied: denied.map((r) => r.id),
    });
    return EXIT_OK;
  }

  sectionHeader(io, "doctor");

  const version = (r: (typeof rows)[number]): string => r.version ?? (r.installed ? "unknown version" : "-");
  // Policy is read by color before it is read by word: it is the only
  // column of this table whose value one looks for rather than its content.
  const policyCell = (r: (typeof rows)[number]): Cell =>
    r.policy.allowed ? { text: "allowed", token: "ok" } : { text: "denied", token: "bad" };
  const tableRows: Cell[][] = options.verbose
    ? rows.map((r) => [
        r.id,
        r.installed ? homePath(r.path ?? "found") : { text: "missing", token: "bad" },
        version(r),
        r.capabilities.join(", ") || "-",
        policyCell(r),
      ])
    : rows.map((r) => [
        r.id,
        r.installed ? version(r) : { text: "missing", token: "bad" },
        { text: r.capabilitiesShort.join(" ") || "-", token: "dim" },
        policyCell(r),
      ]);
  const headers = options.verbose
    ? ["agent", "binary", "version", "capabilities", "policy"]
    : ["agent", "version", "capabilities", "policy"];
  printTable(io, headers, tableRows);
  writeLine(io.stdout);

  if (missing.length === 0 && denied.length === 0) {
    printDone(io, "All the agents of the catalog are installed and allowed by the policy.");
    if (!options.verbose) printNote(io, 'Paths and capabilities spelled out: "caesar doctor --verbose".');
    return EXIT_OK;
  }

  // Two sections, and no longer a single "To fix": a missing binary calls
  // for an action, a denied agent calls for none. Conflating them led this
  // command to suggest lifting a deliberate denial — that of `claude` by
  // `allow_recursion`, which is the default setting, or one that had just
  // been set by hand.
  // A bullet whose continuation comes back to column zero blends into the
  // next item: we wrap on words, and indent the continuation lines.
  const bullet = (text: string): void => {
    for (const line of wrapText(text, terminalWidth(io.stdout), "  - ", "    ")) writeLine(io.stdout, line);
  };

  if (missing.length > 0) {
    printHeading(io, "to install");
    for (const r of missing) {
      // An agent declared in the configuration often carries an explicit
      // path rather than a name: the PATH plays no part then (see
      // `findBinaryInPath`), and mentioning it would send people looking in
      // the wrong place. The advice changes with the cause: one installs a
      // binary missing from the PATH, one fixes a path that points at
      // nothing.
      const explicitPath = r.bin.includes("/");
      bullet(
        explicitPath
          ? `"${r.id}" (${r.display_name}): "${r.bin}" does not exist or is not executable. Fix the path ("caesar agents add ${r.id} --bin <path>"), then rerun "caesar doctor".`
          : `"${r.id}" (${r.display_name}): binary "${r.bin}" not found in the PATH. Install it, then rerun "caesar doctor".`,
      );
    }
    if (denied.length > 0) writeLine(io.stdout);
  }

  if (denied.length > 0) {
    printHeading(io, "denied by the policy");
    printNote(io, "Intended state, unless you decide otherwise.");
    for (const r of denied) {
      // `denied` is filtered on `!r.policy.allowed` above; this guard
      // changes nothing at runtime, it narrows the type of `r.policy` so
      // that `.reason`/`.rule` are accessible below without a cast.
      if (r.policy.allowed) continue;
      // CONTROLLER-1 of the final review: the remedy depends on the rule
      // that denied — neither "caesar agents enable" nor "caesar policy
      // allow" lifts a recursion denial (`allow_recursion`), and only the
      // former lifts a "denied" denial (see `remedyFor`, `@caesar/core`).
      //
      // The layer declaring the rule matters as much as the rule: a command
      // without `--global` writes into the project layer and therefore
      // leaves a denial coming from the global one intact, without anything
      // flagging it.
      const scope = policyFieldProvenance(layers, r.policy.rule === "denied" ? "denied" : "allowed");
      bullet(`"${r.id}": ${r.policy.reason} ${remedyFor(r.id, r.policy.rule, scope)}`);
    }
  }
  return EXIT_OK;
}
