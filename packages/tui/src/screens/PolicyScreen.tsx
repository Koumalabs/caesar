/**
 * Policy screen: the fields of `PolicyConfig` and the `allowed`/`denied`
 * lists.
 *
 * The rewrite is about a single thing, but one that decides everything
 * here: the fields were called `max_parallel`, `allow_recursion`,
 * `max_depth` — the TOML keys, put on screen without a word of
 * explanation. A setting one does not understand does not get adjusted.
 * Each field now carries a plain-language label, and its effect is shown
 * as soon as one pauses on it; the TOML key stays visible at the end of
 * the line, for whoever also edits the file by hand.
 *
 * The rule that surprises — "denied" always wins over "allowed" — is
 * recalled on screen at all times; it is not reimplemented here, it is
 * `isAgentAllowed` (`@caesar/core`) that enforces it everywhere else.
 *
 * Each field shows its **effective** value (`effectiveConfig`) — never
 * `state.draft` directly, which only carries what the active layer
 * declares on its own. A value inherited from a less specific layer is
 * marked ("← global"): this is where it matters most, a single list of
 * individually overridable fields.
 */
import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { PolicyConfig } from "@caesar/core";
import { parseDuration } from "@caesar/core";
import { catalogIds, ISOLATION_OPTIONS, MODE_OPTIONS, NETWORK_OPTIONS, cycle, formatMs } from "./shared";
import {
  effectiveConfig,
  formatInheritedMark,
  policyFieldMark,
  setPolicyListEntry,
  updatePolicy,
  type ConfigState,
  type PolicyListField,
} from "../state/config-state";
import { Explain } from "../ui/Explain";
import { Field } from "../ui/Field";
import { KeyHints, type Hint } from "../ui/KeyHints";
import { Panel } from "../ui/Panel";
import { ACCENT, BAD, DIM, OK, WARN } from "../ui/theme";

export interface PolicyScreenProps {
  state: ConfigState;
  onChange: (next: ConfigState) => void;
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

type Field_ = keyof PolicyConfig;

/** From the most everyday to the most structural: what one comes to adjust first goes first. */
const FIELDS: Field_[] = [
  "default_mode",
  "default_isolation",
  "default_network",
  "default_timeout_ms",
  "max_parallel",
  "max_depth",
  "allow_recursion",
  "allow_inplace_write",
  "allowed",
  "denied",
];

const FIELD_LABELS: Record<Field_, string> = {
  default_mode: "Default mode",
  default_isolation: "Default isolation",
  default_network: "Default network",
  default_timeout_ms: "Default timeout",
  max_parallel: "Parallel tasks",
  max_depth: "Maximum depth",
  allow_recursion: "Recursive delegation",
  allow_inplace_write: "In-place write",
  allowed: "Allowed agents",
  denied: "Denied agents",
};

/** The TOML key, for whoever also edits the file — `default_timeout_ms` is written there without its suffix. */
const TOML_KEYS: Record<Field_, string> = {
  default_mode: "default_mode",
  default_isolation: "default_isolation",
  default_network: "default_network",
  default_timeout_ms: "default_timeout",
  max_parallel: "max_parallel",
  max_depth: "max_depth",
  allow_recursion: "allow_recursion",
  allow_inplace_write: "allow_inplace_write",
  allowed: "allowed",
  denied: "denied",
};

const FIELD_HINTS: Record<Field_, string> = {
  default_mode: "What a task does when unspecified. read-only: the agent must not modify anything.",
  default_isolation:
    "auto: worktree for writes, and for any read-only task given to an agent without a native mode. inplace: the repository itself.",
  default_network:
    "auto: the network opens wherever the agent allows it, and the report says so elsewhere. on: refuses the delegation if the agent cannot open it. off: closes it where possible.",
  default_timeout_ms: 'Beyond this, the task is interrupted. Accepted forms: "10m", "90s", "1h".',
  max_parallel: "Number of tasks run at the same time.",
  max_depth: "A delegated agent can no longer delegate once this depth is reached.",
  allow_recursion: 'Disabled, the "claude" agent is refused: delegating to Claude from Claude Code would be recursion.',
  allow_inplace_write:
    'Disabled, a write task cannot request "inplace" in a git repository: it works on a disposable branch, whose result "caesar diff" shows. Enabled, the sub-agent writes into your working tree, on your current branch, mixed in with your own changes.',
  allowed: "Allowlist. Empty: any agent not denied passes. Non-empty: only the listed agents pass.",
  denied: "Denylist — it always wins over the allowlist.",
};

const LIST_FIELDS = new Set<Field_>(["allowed", "denied"]);
const LABEL_WIDTH = 22;

export function PolicyScreen({ state, onChange, onEditingChange, notify }: PolicyScreenProps) {
  const { width } = useTerminalDimensions();
  const policy = effectiveConfig(state).policy;
  const [fieldIndex, setFieldIndex] = useState(0);
  const [focus, setFocus] = useState<"fields" | "list">("fields");
  const [entryIndex, setEntryIndex] = useState(0);
  const [editing, setEditing] = useState<{ field: "max_parallel" | "max_depth" | "default_timeout_ms"; buffer: string } | null>(null);

  const panelWidth = Math.max(30, width - 6);
  const field = FIELDS[fieldIndex]!;

  function setEditingAndNotifyApp(next: typeof editing): void {
    setEditing(next);
    onEditingChange(next !== null);
  }

  function commitEdit(): void {
    if (!editing) return;
    const raw = editing.buffer.trim();
    try {
      if (editing.field === "default_timeout_ms") {
        onChange(updatePolicy(state, { default_timeout_ms: parseDuration(raw) }));
      } else {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) throw new Error(`"${raw}" is not a valid positive integer.`);
        onChange(updatePolicy(state, { [editing.field]: value } as Partial<PolicyConfig>));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
      return;
    }
    setEditingAndNotifyApp(null);
  }

  useKeyboard((key) => {
    if (editing) return;

    if (focus === "fields") {
      if (key.name === "up" || key.name === "k") setFieldIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down" || key.name === "j") setFieldIndex((i) => Math.min(FIELDS.length - 1, i + 1));
      else if (key.name === "return") {
        if (field === "default_isolation") onChange(updatePolicy(state, { default_isolation: cycle(ISOLATION_OPTIONS, policy.default_isolation) }));
        else if (field === "default_mode") onChange(updatePolicy(state, { default_mode: cycle(MODE_OPTIONS, policy.default_mode) }));
        else if (field === "default_network") onChange(updatePolicy(state, { default_network: cycle(NETWORK_OPTIONS, policy.default_network) }));
        else if (field === "allow_recursion") onChange(updatePolicy(state, { allow_recursion: !policy.allow_recursion }));
        else if (field === "allow_inplace_write")
          onChange(updatePolicy(state, { allow_inplace_write: !policy.allow_inplace_write }));
        else if (field === "max_parallel") setEditingAndNotifyApp({ field: "max_parallel", buffer: String(policy.max_parallel) });
        else if (field === "max_depth") setEditingAndNotifyApp({ field: "max_depth", buffer: String(policy.max_depth) });
        else if (field === "default_timeout_ms") setEditingAndNotifyApp({ field: "default_timeout_ms", buffer: formatMs(policy.default_timeout_ms) });
        else if (LIST_FIELDS.has(field)) {
          setEntryIndex(0);
          setFocus("list");
        }
      }
      return;
    }

    // focus === "list": "allowed" or "denied"
    const listField = field as PolicyListField;
    const entries = policy[listField];
    if (key.name === "escape") setFocus("fields");
    else if (key.name === "up" || key.name === "k") setEntryIndex((i) => Math.max(0, i - 1));
    else if (key.name === "down" || key.name === "j") setEntryIndex((i) => Math.min(Math.max(0, entries.length - 1), i + 1));
    else if (key.name === "a") {
      const next = catalogIds(effectiveConfig(state).agents).find((id) => !entries.includes(id));
      if (next) onChange(setPolicyListEntry(state, listField, next, true));
      else notify("Every catalog agent is already in this list.", true);
    } else if (key.name === "r" || key.name === "delete") {
      const current = entries[entryIndex];
      if (current) {
        onChange(setPolicyListEntry(state, listField, current, false));
        setEntryIndex((i) => Math.max(0, Math.min(i, entries.length - 2)));
      }
    }
  });

  const hints: Hint[] =
    focus === "fields"
      ? [
          { key: "↑↓", label: "setting" },
          { key: "Enter", label: LIST_FIELDS.has(field) ? "open the list" : "edit" },
        ]
      : [
          { key: "↑↓", label: "entry" },
          { key: "a", label: "add an agent" },
          { key: "r", label: "remove" },
          { key: "Esc", label: "back to settings" },
        ];

  function valueOf(name: Field_): { text: string; fg?: string } {
    switch (name) {
      case "default_mode":
        return { text: policy.default_mode };
      case "default_isolation":
        return { text: policy.default_isolation };
      case "default_network":
        return { text: policy.default_network };
      case "default_timeout_ms":
        return { text: formatMs(policy.default_timeout_ms) };
      case "max_parallel":
        return { text: String(policy.max_parallel) };
      case "max_depth":
        return { text: String(policy.max_depth) };
      case "allow_recursion":
        return policy.allow_recursion ? { text: "enabled", fg: WARN } : { text: "disabled", fg: OK };
      case "allow_inplace_write":
        return policy.allow_inplace_write ? { text: "allowed", fg: WARN } : { text: "denied", fg: OK };
      case "allowed":
        return policy.allowed.length > 0
          ? { text: policy.allowed.join(", ") }
          : { text: "(empty — any agent not denied passes)", fg: DIM };
      case "denied":
        return policy.denied.length > 0 ? { text: policy.denied.join(", "), fg: BAD } : { text: "(empty)", fg: DIM };
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel
        title="Policy"
        focused
        note={'Reminder: "denied" always wins over "allowed" — an agent present in both is denied.'}
      >
        {FIELDS.map((name, index) => {
          const selected = index === fieldIndex;
          const { text, fg } = valueOf(name);
          const mark = formatInheritedMark(policyFieldMark(state, name));
          const isEditing = editing?.field === name;

          return (
            <Field
              key={name}
              label={FIELD_LABELS[name]}
              width={panelWidth}
              labelWidth={LABEL_WIDTH}
              selected={selected}
              mark={`${mark}${selected ? `   ${TOML_KEYS[name]}` : ""}`}
              value={isEditing ? undefined : text}
              valueFg={fg}
              below={
                LIST_FIELDS.has(name) && focus === "list" && selected ? (
                  <box flexDirection="column" marginLeft={LABEL_WIDTH + 2}>
                    {policy[name as PolicyListField].length === 0 ? <text fg={DIM}>(empty — "a" to add an agent)</text> : null}
                    {policy[name as PolicyListField].map((id, i) => (
                      <text key={id} fg={i === entryIndex ? ACCENT : undefined}>
                        {(i === entryIndex ? "› " : "  ") + id}
                      </text>
                    ))}
                  </box>
                ) : null
              }
            >
              {isEditing ? (
                <input
                  focused
                  value={editing.buffer}
                  onInput={(value) => setEditing({ field: editing.field, buffer: value })}
                  onSubmit={commitEdit}
                  onKeyDown={(key) => {
                    if (key.name === "escape") setEditingAndNotifyApp(null);
                  }}
                />
              ) : undefined}
            </Field>
          );
        })}
        <Explain text={FIELD_HINTS[field]} width={panelWidth} />
      </Panel>

      <box marginTop="auto" paddingTop={1}>
        <KeyHints hints={hints} />
      </box>
    </box>
  );
}
