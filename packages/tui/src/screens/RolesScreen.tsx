/**
 * Roles screen: the list of roles on the left, editing of the selected
 * role on the right — name, purpose, agents in their fallback order, mode,
 * isolation, timeout, and **the system prompt itself**, content included.
 *
 * That last point is the reason for the rewrite: the field only exposed a
 * file path, while that file *is* the agent's prompt for this role
 * (`resolveRole` places it at the head of the context, see
 * `delegation.ts`). A preview shows it in place, `Enter` opens it full
 * screen (`PromptEditor`).
 *
 * The agent order remains the heart of the screen: reorderable, with the
 * agent picked today computed by `pickAgentForRoleName` (`config-state.ts`,
 * which relies on `pickAgentForRole` from `@caesar/core` — the only
 * fallback rule, never rewritten here).
 *
 * Three-level navigation, and the panel that receives the keys is the one
 * whose border is lit (`Panel`, `focused`) — the old version left two "›"
 * cursors visible without saying which one was listening:
 *  - "roles"  : Up/Down picks the role, "n" creates one, "x" deletes,
 *               Enter enters the fields.
 *  - "fields" : Up/Down picks a field, Enter edits it / cycles it / opens
 *               the prompt editor, Esc goes back to the list.
 *  - "agents" : Up/Down picks a fallback agent, Shift+J/Shift+K moves it,
 *               "a" adds one, "r" removes it, Esc goes back to the fields.
 *
 * Every displayed role is the **effective** version (the merge, not what
 * the active layer declares alone). Renaming and deleting stay reserved
 * for a role the active layer declares itself: the merge-by-key can
 * express neither the deletion nor the renaming of an inherited entry —
 * the old name would keep existing, coming from the layer below.
 */
import { useEffect, useState } from "react";
import type { RoleConfig } from "@caesar/core";
import { parseDuration } from "@caesar/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { catalogIds, ISOLATION_OPTIONS, MODE_OPTIONS, NETWORK_OPTIONS, cycle, formatMs } from "./shared";
import { PromptEditor } from "./PromptEditor";
import { defaultPromptFileFor, readPromptFile, validatePromptFile } from "../state/prompt-file";
import {
  addRoleAgent,
  effectiveConfig,
  formatInheritedMark,
  moveRoleAgent,
  pickAgentForRoleName,
  removeRole,
  removeRoleAgentAt,
  renameRole,
  roleDeclaredByActiveLayer,
  roleMark,
  updateRole,
  upsertRole,
  type ConfigState,
} from "../state/config-state";
import { Explain } from "../ui/Explain";
import { Field } from "../ui/Field";
import { KeyHints, type Hint } from "../ui/KeyHints";
import { Panel } from "../ui/Panel";
import { ACCENT, BAD, DIM, FAINT, OK, WARN } from "../ui/theme";

export interface RolesScreenProps {
  root: string;
  state: ConfigState;
  /** `null` until the installation detection has answered (see `App`). */
  installed: Map<string, boolean> | null;
  onChange: (next: ConfigState) => void;
  /** Signals to `App` that a text input or the prompt editor owns the keyboard. */
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

type Field_ = "name" | "purpose" | "agents" | "mode" | "isolation" | "network" | "timeout" | "prompt";
const FIELDS: Field_[] = ["name", "purpose", "agents", "mode", "isolation", "network", "timeout", "prompt"];
const FIELD_LABELS: Record<Field_, string> = {
  name: "Name",
  purpose: "Purpose",
  agents: "Agents",
  mode: "Mode",
  isolation: "Isolation",
  network: "Network",
  timeout: "Timeout",
  prompt: "System prompt",
};

/** What the field does, shown only when one pauses on it — half of these settings were explained nowhere. */
const FIELD_HINTS: Record<Field_, string> = {
  name: 'The name written in "caesar run --role" and in Claude Code sub-agents.',
  purpose: 'What this role is for. Reproduced as-is by "caesar role list".',
  agents: "Fallback order: the first installed and allowed agent is picked.",
  mode: 'read-only: the agent must not modify anything. write: it may write.',
  isolation: "worktree: disposable working copy. inplace: the repository itself. auto: worktree for writes, and for any read-only task without a native mode.",
  network:
    "auto: open wherever the agent allows it. on: refuses the delegation if the agent cannot open it — codex only knows how in write mode. off: closed where possible.",
  timeout: 'Beyond this, the task is interrupted. Accepted forms: "10m", "90s", "1h".',
  prompt: "The text placed at the head of the agent's context, before the objective. Enter: edit it.",
};

const LABEL_WIDTH = 15;
/** Left panel: enough for a role name, no more — the room belongs to the editing. */
const LIST_WIDTH = 22;

export function RolesScreen({ root, state, installed, onChange, onEditingChange, notify }: RolesScreenProps) {
  const { width } = useTerminalDimensions();
  const roles = effectiveConfig(state).roles;
  const [roleIndex, setRoleIndex] = useState(0);
  const [focus, setFocus] = useState<"roles" | "fields" | "agents">("roles");
  const [fieldIndex, setFieldIndex] = useState(0);
  const [agentIndex, setAgentIndex] = useState(0);
  const [editing, setEditing] = useState<{ kind: "name" | "purpose" | "timeout" | "prompt-file" | "new-role"; buffer: string } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [preview, setPreview] = useState<{ lines: string[]; bytes: number; exists: boolean } | null>(null);

  const clampedRoleIndex = Math.min(roleIndex, Math.max(0, roles.length - 1));
  const role: RoleConfig | undefined = roles[clampedRoleIndex];
  const promptFile = role?.system_prompt_file;

  // Prompt preview: reloaded when the role or its path changes, never on
  // each keystroke. A failed read leaves the preview empty rather than
  // blocking the screen — the path, for its part, stays displayed.
  useEffect(() => {
    if (!promptFile) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void readPromptFile(root, promptFile)
      .then((file) => {
        if (cancelled) return;
        setPreview({ lines: file.content.split("\n").slice(0, 3), bytes: file.content.length, exists: file.exists });
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root, promptFile, promptOpen]);

  function setEditingAndNotifyApp(next: typeof editing): void {
    setEditing(next);
    onEditingChange(next !== null);
  }

  function openPrompt(): void {
    if (!role) return;
    if (!role.system_prompt_file) {
      // A role without a declared prompt: rather than refusing, we propose
      // the conventional path (the one `caesar init` writes) and set it as a
      // pending change. The file, for its part, is only born at Ctrl+S.
      const file = defaultPromptFileFor(role.name);
      onChange(updateRole(state, role.name, { system_prompt_file: file }));
      notify(`Prompt for role "${role.name}" to be created: ${file}. Write it, then Ctrl+S — and "s" to save the path into the configuration.`);
    }
    setPromptOpen(true);
    onEditingChange(true);
  }

  function commitEdit(): void {
    if (!editing) return;

    if (editing.kind === "new-role") {
      const name = editing.buffer.trim();
      if (name.length === 0) {
        notify("The role name cannot be empty.", true);
        return;
      }
      const replaced = roles.some((r) => r.name === name);
      const newRole: RoleConfig = {
        name,
        purpose: "",
        agents: [],
        mode: "write",
        isolation: "auto",
        network: "auto",
        timeout_ms: parseDuration("10m"),
      };
      onChange(upsertRole(state, newRole));
      setRoleIndex(replaced ? roles.findIndex((r) => r.name === name) : roles.length);
      notify(replaced ? `Role "${name}" replaced.` : `Role "${name}" created — Enter to describe it.`);
      setEditingAndNotifyApp(null);
      return;
    }

    if (!role) return;
    if (editing.kind === "name") {
      const name = editing.buffer.trim();
      if (name === role.name) {
        setEditingAndNotifyApp(null);
        return;
      }
      if (name.length === 0) {
        notify("The role name cannot be empty.", true);
        return;
      }
      if (roles.some((r) => r.name === name)) {
        notify(`A role "${name}" already exists.`, true);
        return;
      }
      if (!roleDeclaredByActiveLayer(state, role.name)) {
        notify(
          `"${role.name}" is not declared by the active layer${formatInheritedMark(roleMark(state, role.name))}: renaming it here would let the old name live on in the layer it comes from. Switch scope (p) to rename it where it is declared.`,
          true,
        );
        return;
      }
      onChange(renameRole(state, role.name, name));
      notify(`Role renamed "${name}".`);
    } else if (editing.kind === "purpose") {
      onChange(updateRole(state, role.name, { purpose: editing.buffer }));
    } else if (editing.kind === "prompt-file") {
      const value = editing.buffer.trim();
      if (value.length === 0) {
        onChange(updateRole(state, role.name, { system_prompt_file: undefined }));
      } else {
        const invalid = validatePromptFile(value);
        if (invalid) {
          notify(invalid, true);
          return;
        }
        onChange(updateRole(state, role.name, { system_prompt_file: value }));
      }
    } else if (editing.kind === "timeout") {
      try {
        onChange(updateRole(state, role.name, { timeout_ms: parseDuration(editing.buffer.trim()) }));
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true);
        return;
      }
    }
    setEditingAndNotifyApp(null);
  }

  useKeyboard((key) => {
    if (editing || promptOpen) return; // A text input or the editor owns the keyboard.

    if (focus === "roles") {
      if (key.name === "up" || key.name === "k") setRoleIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down" || key.name === "j") setRoleIndex((i) => Math.min(roles.length - 1, i + 1));
      else if (key.name === "n") setEditingAndNotifyApp({ kind: "new-role", buffer: "" });
      else if (key.name === "x" && role) {
        if (!roleDeclaredByActiveLayer(state, role.name)) {
          notify(
            `"${role.name}" is not declared by the active layer${formatInheritedMark(roleMark(state, role.name))}: nothing to delete here. Edit it (Enter) to redefine it on this layer, or switch scope (p) to edit the layer it comes from.`,
            true,
          );
          return;
        }
        onChange(removeRole(state, role.name));
        notify(`Role "${role.name}" deleted.`);
        setRoleIndex((i) => Math.max(0, Math.min(i, roles.length - 2)));
      } else if ((key.name === "return" || key.name === "right") && role) {
        setFieldIndex(0);
        setFocus("fields");
      }
      return;
    }

    if (focus === "fields") {
      if (!role) {
        setFocus("roles");
        return;
      }
      if (key.name === "escape" || key.name === "left") setFocus("roles");
      else if (key.name === "up" || key.name === "k") setFieldIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down" || key.name === "j") setFieldIndex((i) => Math.min(FIELDS.length - 1, i + 1));
      else if (key.name === "return") {
        const field = FIELDS[fieldIndex]!;
        if (field === "agents") {
          setAgentIndex(0);
          setFocus("agents");
        } else if (field === "mode") {
          onChange(updateRole(state, role.name, { mode: cycle(MODE_OPTIONS, role.mode) }));
        } else if (field === "isolation") {
          onChange(updateRole(state, role.name, { isolation: cycle(ISOLATION_OPTIONS, role.isolation) }));
        } else if (field === "network") {
          onChange(updateRole(state, role.name, { network: cycle(NETWORK_OPTIONS, role.network) }));
        } else if (field === "name") {
          setEditingAndNotifyApp({ kind: "name", buffer: role.name });
        } else if (field === "purpose") {
          setEditingAndNotifyApp({ kind: "purpose", buffer: role.purpose });
        } else if (field === "timeout") {
          setEditingAndNotifyApp({ kind: "timeout", buffer: formatMs(role.timeout_ms) });
        } else if (field === "prompt") {
          openPrompt();
        }
      } else if (key.name === "f" && FIELDS[fieldIndex] === "prompt") {
        setEditingAndNotifyApp({ kind: "prompt-file", buffer: role.system_prompt_file ?? "" });
      }
      return;
    }

    // focus === "agents"
    if (!role) {
      setFocus("roles");
      return;
    }
    // The two "Shift" gestures go before their modifier-less counterparts:
    // a Shift+K keystroke carries `name === "k"`, so it would be absorbed
    // by the cursor movement if that were tested first — reordering, the
    // central gesture of this screen, would no longer work.
    if (key.name === "j" && key.shift) {
      onChange(moveRoleAgent(state, role.name, agentIndex, "down"));
      setAgentIndex((i) => Math.min(role.agents.length - 1, i + 1));
    } else if (key.name === "k" && key.shift) {
      onChange(moveRoleAgent(state, role.name, agentIndex, "up"));
      setAgentIndex((i) => Math.max(0, i - 1));
    } else if (key.name === "escape" || key.name === "left") setFocus("fields");
    else if (key.name === "up" || key.name === "k") setAgentIndex((i) => Math.max(0, i - 1));
    else if (key.name === "down" || key.name === "j") setAgentIndex((i) => Math.min(Math.max(0, role.agents.length - 1), i + 1));
    else if (key.name === "a") {
      const next = catalogIds(effectiveConfig(state).agents).find((id) => !role.agents.includes(id));
      if (next) onChange(addRoleAgent(state, role.name, next));
      else notify("Every catalog agent is already in the list.", true);
    } else if (key.name === "r" || key.name === "delete") {
      if (role.agents.length > 0) {
        onChange(removeRoleAgentAt(state, role.name, agentIndex));
        setAgentIndex((i) => Math.max(0, Math.min(i, role.agents.length - 2)));
      }
    }
  });

  if (promptOpen && role) {
    return (
      <PromptEditor
        root={root}
        roleName={role.name}
        systemPromptFile={role.system_prompt_file ?? defaultPromptFileFor(role.name)}
        notify={notify}
        onClose={() => {
          setPromptOpen(false);
          onEditingChange(false);
        }}
      />
    );
  }

  const pick = role ? pickAgentForRoleName(state, role.name, installed ?? new Map()) : null;
  const pickedAgentId = pick && "agentId" in pick ? pick.agentId : undefined;
  const declaredHere = role ? roleDeclaredByActiveLayer(state, role.name) : false;
  // Borders and indents of the right panel: 2 borders + 2 padding spaces,
  // plus the width of the left panel and the margin between them.
  const detailWidth = Math.max(30, width - LIST_WIDTH - 1 - 4 - 2);

  const hints: Hint[] =
    focus === "roles"
      ? [
          { key: "↑↓", label: "role" },
          { key: "Enter", label: "edit" },
          { key: "n", label: "new" },
          { key: "x", label: "delete" },
        ]
      : focus === "fields"
        ? [
            { key: "↑↓", label: "field" },
            { key: "Enter", label: FIELDS[fieldIndex] === "prompt" ? "edit the prompt" : "edit" },
            ...(FIELDS[fieldIndex] === "prompt" ? [{ key: "f", label: "change the file" }] : []),
            { key: "Esc", label: "back to roles" },
          ]
        : [
            { key: "↑↓", label: "agent" },
            { key: "Shift+J/K", label: "move" },
            { key: "a", label: "add" },
            { key: "r", label: "remove" },
            { key: "Esc", label: "back to fields" },
          ];

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        <Panel title="Roles" focused={focus === "roles"} width={LIST_WIDTH}>
          {roles.length === 0 ? <text fg={DIM}>(none — "n")</text> : null}
          {roles.map((r, index) => {
            const isSelected = index === clampedRoleIndex;
            return (
              <text key={r.name} fg={isSelected ? (focus === "roles" ? ACCENT : undefined) : DIM}>
                {(isSelected ? "› " : "  ") + r.name}
              </text>
            );
          })}
          {editing?.kind === "new-role" ? (
            <box flexDirection="column" marginTop={1}>
              <text fg={ACCENT}>Name:</text>
              <input
                focused
                value={editing.buffer}
                onInput={(value) => setEditing({ kind: "new-role", buffer: value })}
                onSubmit={commitEdit}
                onKeyDown={(key) => {
                  if (key.name === "escape") setEditingAndNotifyApp(null);
                }}
              />
            </box>
          ) : null}
        </Panel>

        <box flexGrow={1} marginLeft={1}>
          <Panel
            title={role ? role.name : "No role"}
            focused={focus !== "roles"}
            flexGrow={1}
            note={
              !role
                ? undefined
                : declaredHere
                  ? "Declared by the active layer."
                  : `Inherited${formatInheritedMark(roleMark(state, role.name))} — editing it will redefine it on the active layer.`
            }
          >
            {!role ? (
              <text fg={DIM}>Select a role, or create one with "n".</text>
            ) : (
              FIELDS.map((field, index) => {
                const selected = focus !== "roles" && index === fieldIndex;
                const common = {
                  label: FIELD_LABELS[field],
                  width: detailWidth,
                  labelWidth: LABEL_WIDTH,
                  selected,
                };

                if (field === "name") {
                  return editing?.kind === "name" ? (
                    <Field key={field} {...common}>
                      <input
                        focused
                        value={editing.buffer}
                        onInput={(value) => setEditing({ kind: "name", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={role.name} />
                  );
                }

                if (field === "purpose") {
                  return editing?.kind === "purpose" ? (
                    <Field key={field} {...common}>
                      <input
                        focused
                        value={editing.buffer}
                        onInput={(value) => setEditing({ kind: "purpose", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={role.purpose || "(not specified)"} valueFg={role.purpose ? undefined : DIM} />
                  );
                }

                if (field === "mode") return <Field key={field} {...common} value={role.mode} />;
                if (field === "isolation") return <Field key={field} {...common} value={role.isolation} />;
                if (field === "network") return <Field key={field} {...common} value={role.network} />;

                if (field === "timeout") {
                  return editing?.kind === "timeout" ? (
                    <Field key={field} {...common}>
                      <input
                        focused
                        value={editing.buffer}
                        onInput={(value) => setEditing({ kind: "timeout", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={formatMs(role.timeout_ms)} />
                  );
                }

                if (field === "agents") {
                  const picked =
                    pickedAgentId ??
                    (pick && "error" in pick ? "none — see below" : installed === null ? "(detecting…)" : "(none)");
                  return (
                    <Field
                      key={field}
                      {...common}
                      value={picked}
                      valueFg={pickedAgentId ? OK : WARN}
                      below={
                        <box flexDirection="column" marginLeft={LABEL_WIDTH + 2}>
                          {role.agents.length === 0 ? <text fg={DIM}>(empty — "a" to add an agent)</text> : null}
                          {role.agents.map((agentId, agentPos) => {
                            const isAgentSelected = focus === "agents" && agentPos === agentIndex;
                            const isPicked = agentId === pickedAgentId;
                            const presence = installed === null ? "…" : installed.get(agentId) ? "installed" : "missing";
                            return (
                              <text
                                key={`${agentId}-${agentPos}`}
                                fg={isAgentSelected ? ACCENT : isPicked ? OK : installed?.get(agentId) === false ? DIM : undefined}
                              >
                                {(isAgentSelected ? "› " : "  ") +
                                  `${agentPos + 1}. ${agentId} (${presence})` +
                                  (isPicked ? "  ← picked" : "")}
                              </text>
                            );
                          })}
                          {pick && "error" in pick ? <text fg={BAD}>{pick.error}</text> : null}
                        </box>
                      }
                    />
                  );
                }

                // field === "prompt"
                return editing?.kind === "prompt-file" ? (
                  <Field key={field} {...common}>
                    <input
                      focused
                      value={editing.buffer}
                      placeholder="(none — relative path under .caesar/)"
                      onInput={(value) => setEditing({ kind: "prompt-file", buffer: value })}
                      onSubmit={commitEdit}
                      onKeyDown={(key) => {
                        if (key.name === "escape") setEditingAndNotifyApp(null);
                      }}
                    />
                  </Field>
                ) : (
                  <Field
                    key={field}
                    {...common}
                    value={
                      role.system_prompt_file
                        ? `${role.system_prompt_file}${preview ? (preview.exists ? ` — ${preview.bytes} characters` : " — to be created") : ""}`
                        : "(none — Enter to write one)"
                    }
                    valueFg={role.system_prompt_file ? undefined : DIM}
                    below={
                      preview && preview.exists ? (
                        <box flexDirection="column" marginLeft={LABEL_WIDTH + 2}>
                          {preview.lines.map((line, lineIndex) => (
                            <text key={lineIndex} fg={FAINT}>
                              {line.slice(0, Math.max(10, detailWidth - LABEL_WIDTH - 4)) || " "}
                            </text>
                          ))}
                        </box>
                      ) : null
                    }
                  />
                );
              })
            )}
            {role && focus !== "roles" ? <Explain text={FIELD_HINTS[FIELDS[fieldIndex]!]} width={detailWidth} /> : null}
          </Panel>
        </box>
      </box>

      <box marginTop="auto" paddingTop={1}>
        <KeyHints hints={hints} />
      </box>
    </box>
  );
}
