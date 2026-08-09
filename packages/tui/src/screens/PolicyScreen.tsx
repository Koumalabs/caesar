/**
 * Écran Politique : les champs de `PolicyConfig`
 * (`max_parallel`, `default_isolation`, `default_mode`, `default_timeout`,
 * `allow_recursion`, `max_depth`) et les listes `allowed`/`denied`.
 *
 * Même modèle de navigation que l'écran Rôles pour rester cohérent :
 * Haut/Bas choisit un champ, Entrée l'édite (texte), le fait cycler
 * (isolation/mode/booléen), ou entre dans la liste (`allowed`/`denied`) où
 * Haut/Bas choisit une entrée, "a" en ajoute une du catalogue, "r" retire
 * l'entrée sélectionnée, Échap revient à la liste des champs.
 *
 * La règle qui surprend — "denied" l'emporte toujours sur "allowed" — est
 * rappelée en permanence à l'écran ; elle n'est pas ré-implémentée ici,
 * c'est `isAgentAllowed` (`@orch/core`) qui la fait vivre partout ailleurs
 * dans l'orchestrateur.
 */
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { PolicyConfig } from "@orch/core";
import { parseDuration } from "@orch/core";
import { catalogIds, ISOLATION_OPTIONS, MODE_OPTIONS, cycle, formatMs } from "./shared";
import { setPolicyListEntry, updatePolicy, type ConfigState, type PolicyListField } from "../state/config-state";

export interface PolicyScreenProps {
  state: ConfigState;
  onChange: (next: ConfigState) => void;
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

type Field = "max_parallel" | "default_isolation" | "default_mode" | "default_timeout_ms" | "allow_recursion" | "max_depth" | "allowed" | "denied";
const FIELDS: Field[] = ["max_parallel", "default_isolation", "default_mode", "default_timeout_ms", "allow_recursion", "max_depth", "allowed", "denied"];
const FIELD_LABELS: Record<Field, string> = {
  max_parallel: "max_parallel",
  default_isolation: "default_isolation",
  default_mode: "default_mode",
  default_timeout_ms: "default_timeout",
  allow_recursion: "allow_recursion",
  max_depth: "max_depth",
  allowed: "allowed",
  denied: "denied",
};
const LIST_FIELDS = new Set<Field>(["allowed", "denied"]);

export function PolicyScreen({ state, onChange, onEditingChange, notify }: PolicyScreenProps) {
  const policy = state.draft.policy;
  const [fieldIndex, setFieldIndex] = useState(0);
  const [focus, setFocus] = useState<"fields" | "list">("fields");
  const [entryIndex, setEntryIndex] = useState(0);
  const [editing, setEditing] = useState<{ field: "max_parallel" | "max_depth" | "default_timeout_ms"; buffer: string } | null>(null);

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
        if (!Number.isInteger(value) || value < 0) throw new Error(`"${raw}" n'est pas un entier positif valide.`);
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
    const field = FIELDS[fieldIndex]!;

    if (focus === "fields") {
      if (key.name === "up") setFieldIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down") setFieldIndex((i) => Math.min(FIELDS.length - 1, i + 1));
      else if (key.name === "return") {
        if (field === "default_isolation") onChange(updatePolicy(state, { default_isolation: cycle(ISOLATION_OPTIONS, policy.default_isolation) }));
        else if (field === "default_mode") onChange(updatePolicy(state, { default_mode: cycle(MODE_OPTIONS, policy.default_mode) }));
        else if (field === "allow_recursion") onChange(updatePolicy(state, { allow_recursion: !policy.allow_recursion }));
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

    // focus === "list" : "allowed" ou "denied"
    const listField = field as PolicyListField;
    const entries = policy[listField];
    if (key.name === "escape") setFocus("fields");
    else if (key.name === "up") setEntryIndex((i) => Math.max(0, i - 1));
    else if (key.name === "down") setEntryIndex((i) => Math.min(Math.max(0, entries.length - 1), i + 1));
    else if (key.name === "a") {
      const next = catalogIds(state.draft.agents).find((id) => !entries.includes(id));
      if (next) onChange(setPolicyListEntry(state, listField, next, true));
      else notify("Tous les agents du catalogue sont déjà dans cette liste.", true);
    } else if (key.name === "r" || key.name === "delete") {
      const current = entries[entryIndex];
      if (current) {
        onChange(setPolicyListEntry(state, listField, current, false));
        setEntryIndex((i) => Math.max(0, Math.min(i, entries.length - 2)));
      }
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg="yellow">Rappel : "denied" l'emporte toujours sur "allowed" — un agent présent dans les deux est refusé.</text>
      <box flexDirection="column" marginTop={1}>
        {FIELDS.map((field, index) => {
          const isSelected = index === fieldIndex;
          const rowColor = isSelected ? (focus === "list" ? "white" : "cyan") : "white";
          return (
            <box key={field} flexDirection="column" marginBottom={LIST_FIELDS.has(field) ? 0 : 0}>
              <box flexDirection="row">
                <text fg={rowColor}>{(isSelected ? "› " : "  ") + FIELD_LABELS[field].padEnd(20)}</text>
                {field === "max_parallel" ? (
                  editing?.field === "max_parallel" ? (
                    <input focused value={editing.buffer} onInput={(v) => setEditing({ field: "max_parallel", buffer: v })} onSubmit={commitEdit} onKeyDown={(k) => k.name === "escape" && setEditingAndNotifyApp(null)} />
                  ) : (
                    <text>{String(policy.max_parallel)}</text>
                  )
                ) : null}
                {field === "default_isolation" ? <text>{policy.default_isolation}</text> : null}
                {field === "default_mode" ? <text>{policy.default_mode}</text> : null}
                {field === "default_timeout_ms" ? (
                  editing?.field === "default_timeout_ms" ? (
                    <input focused value={editing.buffer} onInput={(v) => setEditing({ field: "default_timeout_ms", buffer: v })} onSubmit={commitEdit} onKeyDown={(k) => k.name === "escape" && setEditingAndNotifyApp(null)} />
                  ) : (
                    <text>{formatMs(policy.default_timeout_ms)}</text>
                  )
                ) : null}
                {field === "allow_recursion" ? <text fg={policy.allow_recursion ? "green" : "red"}>{policy.allow_recursion ? "activé" : "désactivé"}</text> : null}
                {field === "max_depth" ? (
                  editing?.field === "max_depth" ? (
                    <input focused value={editing.buffer} onInput={(v) => setEditing({ field: "max_depth", buffer: v })} onSubmit={commitEdit} onKeyDown={(k) => k.name === "escape" && setEditingAndNotifyApp(null)} />
                  ) : (
                    <text>{String(policy.max_depth)}</text>
                  )
                ) : null}
                {LIST_FIELDS.has(field) ? <text fg="gray">{policy[field as PolicyListField].join(", ") || "(vide)"}</text> : null}
              </box>
              {LIST_FIELDS.has(field) && focus === "list" && isSelected
                ? policy[field as PolicyListField].map((id, i) => (
                    <text key={id} fg={i === entryIndex ? "cyan" : "white"}>
                      {"    " + (i === entryIndex ? "› " : "  ") + id}
                    </text>
                  ))
                : null}
            </box>
          );
        })}
      </box>
    </box>
  );
}
