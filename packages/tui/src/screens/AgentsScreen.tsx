/**
 * Agents screen: the catalog as a table, and the selected agent's detail
 * below — presence, version, capabilities, permission, roles that employ
 * it, and for a **declared** agent (`[[agent]]`) its editable fields.
 *
 * Two very distinct gestures, and the screen must keep them so: `Space`
 * allows or denies (a policy list), `n` declares a CLI the native catalog
 * does not know (an `[[agent]]` entry that extends the catalog).
 * Conflating the two would be the easiest misreading to commit here.
 *
 * What the rewrite fixes, all of it drawn from usage:
 *  - columns touched each other (constant widths, no gutter): a truncated
 *    path and the neighboring version read as a single word. `Table` now
 *    computes widths from the actual available room;
 *  - "7 notable(s)" replaced the capabilities with their count. The table
 *    names them (`describeAgentCapabilitiesShort`), the detail expands
 *    them;
 *  - the reason for a denial ran off screen on a single line: it is
 *    wrapped in the detail panel;
 *  - the binary path occupied a column even though it only matters once
 *    one cares about a specific agent — same lesson as `caesar doctor`,
 *    which removed it from its default view. It now lives in the detail.
 *
 * Capabilities and policy status come from
 * `describeAgentCapabilities`/`describeAgentPolicy` (`@caesar/core`) — the
 * same logic that `caesar doctor`/`caesar agents list` use, reused as-is.
 * Installation detection is computed once by `App`: this screen only
 * displays `installed`, never reruns it.
 *
 * Two navigation levels:
 *  - "list"   : Up/Down picks the agent, Space toggles the permission,
 *               `n` declares (identifier typed inline), `x` removes a
 *               declaration, Enter enters a declared agent's fields.
 *  - "fields" : Up/Down picks a field, Enter edits or toggles it, Esc goes
 *               back to the list.
 *
 * Every modification is a pending change on the active layer, like
 * everywhere else in this TUI: nothing is written before "s".
 */
import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  GENERIC_ARG_TOKENS,
  describeAgentCapabilities,
  describeAgentCapabilitiesShort,
  describeAgentPolicy,
  formatArgTemplate,
  listAgentDefinitions,
  splitArgTemplate,
  validateGenericAgentSpec,
} from "@caesar/core";
import type { AgentDefinition, AgentInstallStatus, GenericAgentSpec } from "@caesar/core";
import {
  agentDeclaredByActiveLayer,
  agentMark,
  effectiveConfig,
  findAgentSpec,
  formatInheritedMark,
  modelDeclaredByActiveLayer,
  modelMark,
  policyFieldMark,
  removeAgentSpec,
  updateModel,
  upsertAgentSpec,
  type ConfigState,
} from "../state/config-state";
import { cycle } from "./shared";
import { Field } from "../ui/Field";
import { Explain } from "../ui/Explain";
import { KeyHints, type Hint } from "../ui/KeyHints";
import { Panel } from "../ui/Panel";
import { Table, type TableColumn } from "../ui/Table";
import { ACCENT, BAD, DIM, FAINT, OK, WARN } from "../ui/theme";

export interface AgentsScreenProps {
  state: ConfigState;
  /** `null` until the detection has answered — see `App`. */
  installed: Map<string, AgentInstallStatus> | null;
  onToggleDenied: (agentId: string) => void;
  onChange: (next: ConfigState) => void;
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

type Field_ = "displayName" | "bin" | "args" | "networkArgs" | "cwdMode" | "nativeReadOnly";
const FIELDS: Field_[] = ["displayName", "bin", "args", "networkArgs", "cwdMode", "nativeReadOnly"];
const FIELD_LABELS: Record<Field_, string> = {
  displayName: "Display name",
  bin: "Binary",
  args: "Arguments",
  networkArgs: "Network args",
  cwdMode: "Directory",
  nativeReadOnly: "Read-only",
};
const FIELD_HINTS: Record<Field_, string> = {
  displayName: "How this agent announces itself in lists. Defaults to its identifier.",
  bin: 'The command to launch. A path (with a "/") names a file; a bare name is looked up in the PATH.',
  args: `Command-line template. Tokens: ${GENERIC_ARG_TOKENS.map((name) => `{{${name}}}`).join(" ")}. An argument whose token has no value disappears entirely.`,
  networkArgs:
    'What must be added to open the network, e.g. --allow-all-urls. Declaring them asserts that without them this CLI is confined — otherwise caesar reports "network unknown" and promises nothing.',
  cwdMode: "process: the current directory carries the workspace. flag: it is already passed as an argument.",
  nativeReadOnly: "Does the CLI itself guarantee it writes nothing? Otherwise, a read-only task is isolated in a worktree.",
};

const CWD_MODES = ["process", "flag"] as const;
const LABEL_WIDTH = 14;

/** The argument template as it is edited: a command line, not a list. */
function argsLine(spec: GenericAgentSpec): string {
  return formatArgTemplate(spec.args);
}

function networkArgsLine(spec: GenericAgentSpec): string {
  return formatArgTemplate(spec.networkArgs ?? []);
}

export function AgentsScreen({ state, installed, onToggleDenied, onChange, onEditingChange, notify }: AgentsScreenProps) {
  const { width } = useTerminalDimensions();
  const config = effectiveConfig(state);
  // Native catalog extended with the configuration's agents
  // (`config.agents`, `[[agent]]` in the TOML, effective merge): recomputed
  // on every render, otherwise a newly declared agent would never appear
  // (C1 of the final review). A declared agent for which detection has not
  // run honestly shows "…" rather than a false "missing".
  const CATALOG = listAgentDefinitions(config.agents);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState<"list" | "fields">("list");
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editing, setEditing] = useState<{ kind: "new-agent" | "model" | "displayName" | "bin" | "args" | "networkArgs"; buffer: string } | null>(null);

  const deniedMark = formatInheritedMark(policyFieldMark(state, "denied"));
  const allowedMark = formatInheritedMark(policyFieldMark(state, "allowed"));

  const clamped = Math.min(selected, Math.max(0, CATALOG.length - 1));
  const def = CATALOG[clamped];
  const spec = def ? findAgentSpec(state, def.id) : undefined;
  // Panel borders and padding, plus `App`'s margin.
  const panelWidth = Math.max(30, width - 6);

  function setEditingAndNotifyApp(next: typeof editing): void {
    setEditing(next);
    onEditingChange(next !== null);
  }

  /**
   * Applies a declaration change after validation. Validation does not
   * cover only the current input: an argument template and a binary are
   * validated together (`validateGenericAgentSpec`), so it is the whole
   * declaration that is submitted, as it would be after this change.
   * Nothing is modified if it does not hold.
   */
  function applySpec(next: GenericAgentSpec): boolean {
    const invalid = validateGenericAgentSpec(next);
    if (invalid) {
      notify(invalid, true);
      return false;
    }
    onChange(upsertAgentSpec(state, next));
    return true;
  }

  function commitEdit(): void {
    if (!editing) return;

    if (editing.kind === "new-agent") {
      const id = editing.buffer.trim();
      // Minimal but immediately valid declaration: the binary equals the
      // identifier (the most frequent case — `aider` is launched by
      // `aider`), and the template reduces to the single mandatory token.
      // The fields are then refined in the panel, like for a role.
      const draft: GenericAgentSpec = { id, bin: id, args: ["{{prompt}}"], cwdMode: "process" };
      const invalid = validateGenericAgentSpec(draft);
      if (invalid) {
        notify(invalid, true);
        return;
      }
      onChange(upsertAgentSpec(state, draft));
      const existing = CATALOG.findIndex((d) => d.id === id);
      setSelected(existing >= 0 ? existing : CATALOG.length);
      notify(
        existing >= 0
          ? `Agent "${id}" redeclared — this declaration replaces the agent with the same identifier.`
          : `Agent "${id}" declared. Adjust its binary and arguments, then "s" to save.`,
      );
      setEditingAndNotifyApp(null);
      return;
    }

    // Before the `spec` guard: the default model applies to native agents
    // too — that is precisely why it is not one of the `[[agent]]` fields.
    if (editing.kind === "model") {
      if (!def) return;
      const value = editing.buffer.trim();
      if (value.length === 0) {
        if (config.models[def.id] !== undefined && !modelDeclaredByActiveLayer(state, def.id)) {
          notify(
            `"${def.id}"'s default model is inherited${formatInheritedMark(modelMark(state, def.id))}: removing it here cannot hide it. Switch scope (p) to remove it where it is declared.`,
            true,
          );
          return;
        }
        onChange(updateModel(state, def.id, undefined));
      } else {
        onChange(updateModel(state, def.id, value));
        if (!def.capabilities.model) {
          notify(`"${def.id}" does not support choosing a model: this default will be ignored (with a report finding) until it does.`);
        }
      }
      setEditingAndNotifyApp(null);
      return;
    }

    if (!def || !spec) return;
    if (editing.kind === "displayName") {
      const value = editing.buffer.trim();
      const next: GenericAgentSpec = { ...spec };
      if (value.length === 0) delete next.displayName;
      else next.displayName = value;
      if (!applySpec(next)) return;
    } else if (editing.kind === "bin") {
      if (!applySpec({ ...spec, bin: editing.buffer.trim() })) return;
    } else if (editing.kind === "args") {
      let args: string[];
      try {
        args = splitArgTemplate(editing.buffer);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true);
        return;
      }
      if (!applySpec({ ...spec, args })) return;
    } else if (editing.kind === "networkArgs") {
      let networkArgs: string[];
      try {
        networkArgs = splitArgTemplate(editing.buffer);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true);
        return;
      }
      const next: GenericAgentSpec = { ...spec };
      // An empty list is not "no network arguments declared": it would
      // switch the capability to "toggle" without opening anything. Absent,
      // it honestly leaves "network unknown".
      if (networkArgs.length === 0) delete next.networkArgs;
      else next.networkArgs = networkArgs;
      if (!applySpec(next)) return;
    }
    setEditingAndNotifyApp(null);
  }

  useKeyboard((key) => {
    if (editing) return; // The text field shown below owns the focus and handles its own keys.

    if (focus === "fields") {
      if (!def || !spec) {
        setFocus("list");
        return;
      }
      if (key.name === "escape") setFocus("list");
      else if (key.name === "up" || key.name === "k") setFieldIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down" || key.name === "j") setFieldIndex((i) => Math.min(FIELDS.length - 1, i + 1));
      else if (key.name === "return") {
        const field = FIELDS[fieldIndex]!;
        if (field === "cwdMode") {
          applySpec({ ...spec, cwdMode: cycle(CWD_MODES, spec.cwdMode ?? "process") });
        } else if (field === "nativeReadOnly") {
          const nativeReadOnly = !(spec.capabilities?.nativeReadOnly ?? false);
          const next: GenericAgentSpec = { ...spec };
          // Never leave `capabilities: { nativeReadOnly: false }` in the
          // TOML: an explicitly written false capability reads as a
          // decision, when it is the default.
          if (nativeReadOnly) next.capabilities = { nativeReadOnly: true };
          else delete next.capabilities;
          applySpec(next);
        } else if (field === "displayName") {
          setEditingAndNotifyApp({ kind: "displayName", buffer: spec.displayName ?? "" });
        } else if (field === "bin") {
          setEditingAndNotifyApp({ kind: "bin", buffer: spec.bin });
        } else if (field === "args") {
          setEditingAndNotifyApp({ kind: "args", buffer: argsLine(spec) });
        } else if (field === "networkArgs") {
          setEditingAndNotifyApp({ kind: "networkArgs", buffer: networkArgsLine(spec) });
        }
      }
      return;
    }

    // focus === "list"
    if (key.name === "up" || key.name === "k") setSelected((i) => Math.max(0, i - 1));
    else if (key.name === "down" || key.name === "j") setSelected((i) => Math.min(CATALOG.length - 1, i + 1));
    else if (key.name === "space") {
      if (def) onToggleDenied(def.id);
    } else if (key.name === "n") {
      setEditingAndNotifyApp({ kind: "new-agent", buffer: "" });
    } else if (key.name === "m") {
      // From the list, not the fields: the fields belong to `[[agent]]`
      // declarations, while the default model must stay editable for the
      // native catalog too.
      if (def) setEditingAndNotifyApp({ kind: "model", buffer: config.models[def.id] ?? "" });
    } else if (key.name === "x") {
      if (!def) return;
      if (!spec) {
        notify(
          `"${def.id}" belongs to the native catalog: there is no declaration to remove. To keep it out of delegations, use Space (permission).`,
          true,
        );
        return;
      }
      if (!agentDeclaredByActiveLayer(state, def.id)) {
        notify(
          `"${def.id}" is not declared by the active layer${formatInheritedMark(agentMark(state, def.id))}: nothing to remove here. Switch scope (p) to edit the layer it comes from.`,
          true,
        );
        return;
      }
      onChange(removeAgentSpec(state, def.id));
      notify(`Declaration of "${def.id}" removed.`);
      setSelected((i) => Math.max(0, Math.min(i, CATALOG.length - 2)));
    } else if (key.name === "return") {
      if (!def) return;
      if (spec) {
        setFieldIndex(0);
        setFocus("fields");
      } else {
        notify(`"${def.id}" is a native catalog agent: its fields cannot be edited. "n" declares a CLI outside the catalog.`);
      }
    }
  });

  const presenceOf = (agent: AgentDefinition): string => {
    const status = installed?.get(agent.id);
    if (status === undefined) return "…";
    if (!status.installed) return "missing";
    return status.version ?? "installed";
  };

  // The variable column goes last: the ragged edge then falls at the right
  // of the screen, not between two columns one would want aligned.
  const columns: Array<TableColumn<AgentDefinition>> = [
    {
      header: "agent",
      min: 16,
      cell: (agent) => agent.id + (config.agents.some((a) => a.id === agent.id) ? " *" : ""),
    },
    {
      // A CLI version is verbose ("2.1.227 (Claude Code)"): this column
      // takes its share of the free room rather than truncating it while a
      // wide terminal sits half empty.
      header: "status",
      min: 16,
      flex: 1,
      max: 26,
      cell: presenceOf,
      fg: (agent) => {
        const status = installed?.get(agent.id);
        if (status === undefined) return DIM;
        return status.installed ? OK : WARN;
      },
    },
    {
      header: "permission",
      min: 14,
      cell: (agent) => (describeAgentPolicy(config.policy, agent.id).allowed ? "allowed" : "denied"),
      fg: (agent) => (describeAgentPolicy(config.policy, agent.id).allowed ? OK : BAD),
    },
    { header: "capabilities", min: 24, flex: 2, max: 46, cell: (agent) => describeAgentCapabilitiesShort(agent).join(" ") || "—" },
  ];

  const policy = def ? describeAgentPolicy(config.policy, def.id) : null;
  const status = def ? installed?.get(def.id) : undefined;
  const usedBy = def
    ? config.roles
        .map((role) => ({ role, rank: role.agents.indexOf(def.id) }))
        .filter((entry) => entry.rank >= 0)
        .map((entry) => `${entry.role.name} (${entry.rank + 1}${entry.rank === 0 ? "st" : entry.rank === 1 ? "nd" : entry.rank === 2 ? "rd" : "th"})`)
    : [];

  const hints: Hint[] =
    focus === "list"
      ? [
          { key: "↑↓", label: "agent" },
          { key: "Space", label: "allow / deny" },
          { key: "n", label: "declare a CLI" },
          { key: "m", label: "default model" },
          ...(spec ? [{ key: "Enter", label: "edit" }, { key: "x", label: "remove the declaration" }] : []),
        ]
      : [
          { key: "↑↓", label: "field" },
          { key: "Enter", label: "edit" },
          { key: "Esc", label: "back to the list" },
        ];

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title="Catalog" focused={focus === "list"}>
        <Table
          columns={columns}
          rows={CATALOG}
          keyOf={(agent) => agent.id}
          selectedIndex={clamped}
          focused={focus === "list"}
          width={panelWidth}
        />
        {installed === null ? <text fg={WARN}>Detecting installation…</text> : null}
        {config.agents.length > 0 ? <text fg={FAINT}>* declared in configuration</text> : null}
        {deniedMark ? <text fg={FAINT}>{`"denied" inherited${deniedMark} — Space takes it over on the active layer.`}</text> : null}
        {allowedMark ? <text fg={FAINT}>{`"allowed" inherited${allowedMark} — editing it will take it over on the active layer.`}</text> : null}
      </Panel>

      {editing?.kind === "new-agent" ? (
        <Panel title="Declare an agent" focused note='Identifier — the one written in "caesar run --agent" and in roles.'>
          <box flexDirection="row">
            <text>{"Identifier    "}</text>
            <input
              focused
              value={editing.buffer}
              onInput={(value) => setEditing({ kind: "new-agent", buffer: value })}
              onSubmit={commitEdit}
              onKeyDown={(key) => {
                if (key.name === "escape") setEditingAndNotifyApp(null);
              }}
            />
          </box>
        </Panel>
      ) : editing?.kind === "model" && def ? (
        <Panel
          title={`Default model — ${def.id}`}
          focused
          note="Requested when neither an explicit model nor the role chooses one. Empty: back to the provider's default."
        >
          <box flexDirection="row">
            <text>{"Model         "}</text>
            <input
              focused
              value={editing.buffer}
              onInput={(value) => setEditing({ kind: "model", buffer: value })}
              onSubmit={commitEdit}
              onKeyDown={(key) => {
                if (key.name === "escape") setEditingAndNotifyApp(null);
              }}
            />
          </box>
        </Panel>
      ) : def ? (
        <Panel
          title={def.displayName === def.id ? def.id : `${def.id} — ${def.displayName}`}
          focused={focus === "fields"}
          note={
            spec
              ? agentDeclaredByActiveLayer(state, def.id)
                ? "Declared by the active layer — Enter to edit its fields."
                : `Declared${formatInheritedMark(agentMark(state, def.id))} — editing it will redefine it on the active layer.`
              : "Agent from the native catalog: wired into the orchestrator, its fields cannot be edited."
          }
        >
          {spec ? (
            <>
              <Field
                label="Command"
                width={panelWidth}
                labelWidth={LABEL_WIDTH}
                value={`${spec.bin} ${argsLine(spec)}`}
                valueFg={DIM}
              />
              {FIELDS.map((field, index) => {
                const selected = focus === "fields" && index === fieldIndex;
                const common = { label: FIELD_LABELS[field], width: panelWidth, labelWidth: LABEL_WIDTH, selected };

                if (field === "displayName") {
                  return editing?.kind === "displayName" ? (
                    <Field key={field} {...common}>
                      <input
                        focused
                        value={editing.buffer}
                        placeholder="(the identifier)"
                        onInput={(value) => setEditing({ kind: "displayName", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={spec.displayName ?? `(the identifier: ${def.id})`} valueFg={spec.displayName ? undefined : DIM} />
                  );
                }

                if (field === "bin") {
                  return editing?.kind === "bin" ? (
                    <Field key={field} {...common}>
                      <input
                        focused
                        value={editing.buffer}
                        onInput={(value) => setEditing({ kind: "bin", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={spec.bin} />
                  );
                }

                if (field === "args") {
                  return editing?.kind === "args" ? (
                    <Field key={field} {...common}>
                      <input
                        focused
                        value={editing.buffer}
                        onInput={(value) => setEditing({ kind: "args", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={argsLine(spec)} />
                  );
                }

                if (field === "networkArgs") {
                  return editing?.kind === "networkArgs" ? (
                    <Field key={field} {...common}>
                      <input
                        focused
                        value={editing.buffer}
                        onInput={(value) => setEditing({ kind: "networkArgs", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={networkArgsLine(spec) || "(none — network unknown)"} />
                  );
                }

                if (field === "cwdMode") {
                  return <Field key={field} {...common} value={spec.cwdMode ?? "process"} />;
                }

                return (
                  <Field
                    key={field}
                    {...common}
                    value={spec.capabilities?.nativeReadOnly ? "yes" : "no"}
                    valueFg={spec.capabilities?.nativeReadOnly ? OK : undefined}
                  />
                );
              })}
            </>
          ) : (
            <>
              <Field label="Binary" width={panelWidth} labelWidth={LABEL_WIDTH} value={def.bin} />
              <Field
                label="Found"
                width={panelWidth}
                labelWidth={LABEL_WIDTH}
                value={status === undefined ? "detecting…" : (status.path ?? "not in PATH")}
                valueFg={status === undefined ? DIM : status.installed ? OK : WARN}
              />
              <Field
                label="Version"
                width={panelWidth}
                labelWidth={LABEL_WIDTH}
                value={status?.version ?? (status?.installed ? "unknown" : "—")}
              />
              <Field
                label="Capabilities"
                width={panelWidth}
                labelWidth={LABEL_WIDTH}
                value={describeAgentCapabilities(def).join(", ") || "(no notable capabilities)"}
              />
            </>
          )}

          {/* Outside the `spec` fork, like Permission and Used by: the
              default model concerns native agents as much as declared ones.
              A value the agent cannot honor is flagged rather than shown
              bare — displayed as applied, it would lie about the launch. */}
          <Field
            label="Default model"
            width={panelWidth}
            labelWidth={LABEL_WIDTH}
            value={
              config.models[def.id] === undefined
                ? "(none — provider default)"
                : def.capabilities.model
                  ? `${config.models[def.id]}${formatInheritedMark(modelMark(state, def.id))}`
                  : `${config.models[def.id]} (ignored: no model choice)`
            }
            valueFg={config.models[def.id] === undefined ? DIM : def.capabilities.model ? undefined : WARN}
          />
          {policy ? (
            <Field
              label="Permission"
              width={panelWidth}
              labelWidth={LABEL_WIDTH}
              value={policy.allowed ? "allowed" : policy.reason}
              valueFg={policy.allowed ? OK : BAD}
            />
          ) : null}
          <Field
            label="Used by"
            width={panelWidth}
            labelWidth={LABEL_WIDTH}
            value={usedBy.length > 0 ? usedBy.join(", ") : "no roles"}
            valueFg={usedBy.length > 0 ? undefined : DIM}
          />
          {focus === "fields" ? <Explain text={FIELD_HINTS[FIELDS[fieldIndex]!]} width={panelWidth} /> : null}
        </Panel>
      ) : (
        <text fg={ACCENT}>No agents — "n" to declare one.</text>
      )}

      {/* `marginTop: "auto"` pins the bar to the bottom of the body: the
          panels keep the height of their content, without a half-empty
          frame. */}
      <box marginTop="auto" paddingTop={1}>
        <KeyHints hints={hints} />
      </box>
    </box>
  );
}
