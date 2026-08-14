/**
 * Écran Politique : les champs de `PolicyConfig` et les listes
 * `allowed`/`denied`.
 *
 * La réécriture porte sur une seule chose, mais qui décide de tout ici : les
 * champs s'appelaient `max_parallel`, `allow_recursion`, `max_depth` — les
 * clés du TOML, posées à l'écran sans un mot d'explication. Un réglage qu'on
 * ne comprend pas ne se règle pas. Chaque champ porte désormais un intitulé
 * en français, et son effet s'affiche dès qu'on s'arrête dessus ; la clé
 * TOML reste visible en fin de ligne, pour qui édite aussi le fichier à la
 * main.
 *
 * La règle qui surprend — "denied" l'emporte toujours sur "allowed" — est
 * rappelée en permanence à l'écran ; elle n'est pas réimplémentée ici, c'est
 * `isAgentAllowed` (`@caesar/core`) qui la fait vivre partout ailleurs.
 *
 * Chaque champ affiche sa valeur **effective** (`effectiveConfig`) — jamais
 * `state.draft` directement, qui ne porte que ce que la couche active
 * déclare en propre. Une valeur héritée d'une couche moins spécifique se
 * marque (« ← global ») : c'est ici qu'elle compte le plus, une seule liste
 * de champs individuellement surchargeables.
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

/** Du plus quotidien au plus structurel : ce qu'on vient régler d'abord passe en premier. */
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
  default_mode: "Mode par défaut",
  default_isolation: "Isolation par défaut",
  default_network: "Réseau par défaut",
  default_timeout_ms: "Délai par défaut",
  max_parallel: "Tâches en parallèle",
  max_depth: "Profondeur maximale",
  allow_recursion: "Délégation récursive",
  allow_inplace_write: "Écriture en place",
  allowed: "Agents autorisés",
  denied: "Agents refusés",
};

/** La clé du TOML, pour qui édite aussi le fichier — `default_timeout_ms` s'y écrit sans son suffixe. */
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
  default_mode: "Ce qu'une tâche fait à défaut de précision. read-only : l'agent ne doit rien modifier.",
  default_isolation:
    "auto : worktree en écriture, et pour toute lecture seule confiée à un agent sans mode natif. inplace : le dépôt lui-même.",
  default_network:
    "auto : le réseau s'ouvre partout où l'agent le permet, et le rapport le dit ailleurs. on : refuse la délégation si l'agent ne sait pas l'ouvrir. off : ferme là où c'est possible.",
  default_timeout_ms: 'Au-delà, la tâche est interrompue. Formes acceptées : "10m", "90s", "1h".',
  max_parallel: "Nombre de tâches menées de front.",
  max_depth: "Un agent délégataire ne peut plus déléguer une fois cette profondeur atteinte.",
  allow_recursion: 'Désactivé, l\'agent "claude" est refusé : déléguer à Claude depuis Claude Code serait une récursion.',
  allow_inplace_write:
    'Désactivé, une tâche en écriture ne peut pas demander "inplace" dans un dépôt git : elle travaille sur une branche jetable, dont "caesar diff" montre le résultat. Activé, le sous-agent écrit dans votre arbre de travail, sur votre branche courante, mêlé à vos propres modifications.',
  allowed: "Liste blanche. Vide : tout agent non refusé passe. Non vide : seuls les agents listés passent.",
  denied: "Liste noire — elle l'emporte toujours sur la liste blanche.",
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

    // focus === "list" : "allowed" ou "denied"
    const listField = field as PolicyListField;
    const entries = policy[listField];
    if (key.name === "escape") setFocus("fields");
    else if (key.name === "up" || key.name === "k") setEntryIndex((i) => Math.max(0, i - 1));
    else if (key.name === "down" || key.name === "j") setEntryIndex((i) => Math.min(Math.max(0, entries.length - 1), i + 1));
    else if (key.name === "a") {
      const next = catalogIds(effectiveConfig(state).agents).find((id) => !entries.includes(id));
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

  const hints: Hint[] =
    focus === "fields"
      ? [
          { key: "↑↓", label: "réglage" },
          { key: "Entrée", label: LIST_FIELDS.has(field) ? "ouvrir la liste" : "modifier" },
        ]
      : [
          { key: "↑↓", label: "entrée" },
          { key: "a", label: "ajouter un agent" },
          { key: "r", label: "retirer" },
          { key: "Échap", label: "revenir aux réglages" },
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
        return policy.allow_recursion ? { text: "activée", fg: WARN } : { text: "désactivée", fg: OK };
      case "allow_inplace_write":
        return policy.allow_inplace_write ? { text: "autorisée", fg: WARN } : { text: "refusée", fg: OK };
      case "allowed":
        return policy.allowed.length > 0
          ? { text: policy.allowed.join(", ") }
          : { text: "(vide — tout agent non refusé passe)", fg: DIM };
      case "denied":
        return policy.denied.length > 0 ? { text: policy.denied.join(", "), fg: BAD } : { text: "(vide)", fg: DIM };
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel
        title="Politique"
        focused
        note={'Rappel : "denied" l\'emporte toujours sur "allowed" — un agent présent dans les deux est refusé.'}
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
                    {policy[name as PolicyListField].length === 0 ? <text fg={DIM}>(vide — "a" pour ajouter un agent)</text> : null}
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
