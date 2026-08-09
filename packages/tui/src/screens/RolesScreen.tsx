/**
 * Écran Rôles : la liste des rôles à gauche, l'édition du rôle sélectionné à
 * droite — intention, agents préférés dans leur ordre de repli, mode,
 * isolation, timeout, prompt système. Création et suppression de rôle.
 *
 * L'ordre des agents est le cœur de l'écran : réordonnable, avec l'agent
 * retenu aujourd'hui affiché en s'appuyant sur `pickAgentForRoleName`
 * (`config-state.ts`, qui s'appuie lui-même sur `pickAgentForRole` de
 * `@orch/core` — la seule règle de repli, jamais réécrite ici).
 *
 * Navigation à trois niveaux :
 *  - "roles"  : Haut/Bas choisit le rôle. "n" en crée un (nom saisi en
 *               ligne), "x" supprime le rôle sélectionné (pas de confirmation
 *               séparée : une suppression n'est qu'une modification en
 *               attente, déjà protégée par "s" explicite et la confirmation
 *               de sortie — voir `App`). Entrée entre dans "fields".
 *  - "fields" : Haut/Bas choisit un champ du rôle. Entrée l'édite (texte),
 *               le fait cycler (mode/isolation), ou entre dans "agents"
 *               (champ agents). Échap revient à "roles".
 *  - "agents" : Haut/Bas choisit un agent de l'ordre de repli. "J"/"K" le
 *               déplace, "a" en ajoute un du catalogue non encore présent,
 *               "r" retire l'agent sélectionné. Échap revient à "fields".
 */
import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { RoleConfig } from "@orch/core";
import { listAgentDefinitions, parseDuration } from "@orch/core";
import { IsolationSchema, TaskModeSchema } from "@orch/protocol";
import {
  addRoleAgent,
  findRole,
  moveRoleAgent,
  pickAgentForRoleName,
  removeRole,
  removeRoleAgentAt,
  updateRole,
  upsertRole,
  type ConfigState,
} from "../state/config-state";

export interface RolesScreenProps {
  state: ConfigState;
  /** `null` tant que la détection d'installation n'a pas répondu (voir `App`). */
  installed: Map<string, boolean> | null;
  onChange: (next: ConfigState) => void;
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

const MODE_OPTIONS = TaskModeSchema.options;
const ISOLATION_OPTIONS = [...IsolationSchema.options, "auto"] as const;
const CATALOG_IDS = listAgentDefinitions().map((def) => def.id);

type Field = "purpose" | "agents" | "mode" | "isolation" | "timeout" | "system_prompt_file";
const FIELDS: Field[] = ["purpose", "agents", "mode", "isolation", "timeout", "system_prompt_file"];
const FIELD_LABELS: Record<Field, string> = {
  purpose: "Intention",
  agents: "Agents (ordre de repli)",
  mode: "Mode",
  isolation: "Isolation",
  timeout: "Délai",
  system_prompt_file: "Prompt système (fichier)",
};

function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function cycle<T>(options: readonly T[], current: T): T {
  const index = options.indexOf(current);
  return options[(index + 1) % options.length]!;
}

export function RolesScreen({ state, installed, onChange, onEditingChange, notify }: RolesScreenProps) {
  const roles = state.draft.roles;
  const [roleIndex, setRoleIndex] = useState(0);
  const [focus, setFocus] = useState<"roles" | "fields" | "agents">("roles");
  const [fieldIndex, setFieldIndex] = useState(0);
  const [agentIndex, setAgentIndex] = useState(0);
  const [editing, setEditing] = useState<{ kind: "purpose" | "timeout" | "system_prompt_file" | "new-role"; buffer: string } | null>(null);

  const clampedRoleIndex = Math.min(roleIndex, Math.max(0, roles.length - 1));
  const role: RoleConfig | undefined = roles[clampedRoleIndex];

  function setEditingAndNotifyApp(next: typeof editing): void {
    setEditing(next);
    onEditingChange(next !== null);
  }

  function commitEdit(): void {
    if (!editing) return;
    if (editing.kind === "new-role") {
      const name = editing.buffer.trim();
      if (name.length === 0) {
        notify("Le nom du rôle ne peut pas être vide.", true);
        return;
      }
      const replaced = roles.some((r) => r.name === name);
      const newRole: RoleConfig = {
        name,
        purpose: "",
        agents: [],
        mode: "write",
        isolation: "auto",
        timeout_ms: parseDuration("10m"),
      };
      onChange(upsertRole(state, newRole));
      setRoleIndex(replaced ? roles.findIndex((r) => r.name === name) : roles.length);
      notify(replaced ? `Rôle "${name}" remplacé.` : `Rôle "${name}" créé.`);
      setEditingAndNotifyApp(null);
      return;
    }

    if (!role) return;
    if (editing.kind === "purpose") {
      onChange(updateRole(state, role.name, { purpose: editing.buffer }));
    } else if (editing.kind === "system_prompt_file") {
      const value = editing.buffer.trim();
      const patch: Partial<RoleConfig> = value.length === 0 ? { system_prompt_file: undefined } : { system_prompt_file: value };
      onChange(updateRole(state, role.name, patch));
    } else if (editing.kind === "timeout") {
      try {
        const timeout_ms = parseDuration(editing.buffer.trim());
        onChange(updateRole(state, role.name, { timeout_ms }));
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true);
        return;
      }
    }
    setEditingAndNotifyApp(null);
  }

  useKeyboard((key) => {
    if (editing) return; // Le champ texte affiché ci-dessous possède le focus et gère lui-même ses touches.

    if (focus === "roles") {
      if (key.name === "up") setRoleIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down") setRoleIndex((i) => Math.min(roles.length - 1, i + 1));
      else if (key.name === "n") setEditingAndNotifyApp({ kind: "new-role", buffer: "" });
      else if (key.name === "x" && role) {
        onChange(removeRole(state, role.name));
        notify(`Rôle "${role.name}" supprimé.`);
        setRoleIndex((i) => Math.max(0, Math.min(i, roles.length - 2)));
      } else if (key.name === "return" && role) {
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
      if (key.name === "escape") setFocus("roles");
      else if (key.name === "up") setFieldIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down") setFieldIndex((i) => Math.min(FIELDS.length - 1, i + 1));
      else if (key.name === "return") {
        const field = FIELDS[fieldIndex]!;
        if (field === "agents") {
          setAgentIndex(0);
          setFocus("agents");
        } else if (field === "mode") {
          onChange(updateRole(state, role.name, { mode: cycle(MODE_OPTIONS, role.mode) }));
        } else if (field === "isolation") {
          onChange(updateRole(state, role.name, { isolation: cycle(ISOLATION_OPTIONS, role.isolation) }));
        } else if (field === "purpose") {
          setEditingAndNotifyApp({ kind: "purpose", buffer: role.purpose });
        } else if (field === "timeout") {
          setEditingAndNotifyApp({ kind: "timeout", buffer: formatMs(role.timeout_ms) });
        } else if (field === "system_prompt_file") {
          setEditingAndNotifyApp({ kind: "system_prompt_file", buffer: role.system_prompt_file ?? "" });
        }
      }
      return;
    }

    // focus === "agents"
    if (!role) {
      setFocus("roles");
      return;
    }
    if (key.name === "escape") setFocus("fields");
    else if (key.name === "up") setAgentIndex((i) => Math.max(0, i - 1));
    else if (key.name === "down") setAgentIndex((i) => Math.min(Math.max(0, role.agents.length - 1), i + 1));
    else if (key.name === "j" && key.shift) {
      onChange(moveRoleAgent(state, role.name, agentIndex, "down"));
      setAgentIndex((i) => Math.min(role.agents.length - 1, i + 1));
    } else if (key.name === "k" && key.shift) {
      onChange(moveRoleAgent(state, role.name, agentIndex, "up"));
      setAgentIndex((i) => Math.max(0, i - 1));
    } else if (key.name === "a") {
      const next = CATALOG_IDS.find((id) => !role.agents.includes(id));
      if (next) onChange(addRoleAgent(state, role.name, next));
      else notify("Tous les agents du catalogue sont déjà dans la liste.", true);
    } else if (key.name === "r" || key.name === "delete") {
      if (role.agents.length > 0) {
        onChange(removeRoleAgentAt(state, role.name, agentIndex));
        setAgentIndex((i) => Math.max(0, Math.min(i, role.agents.length - 2)));
      }
    }
  });

  const pick = role ? pickAgentForRoleName(state, role.name, installed ?? new Map()) : null;
  const pickedAgentId = pick && "agentId" in pick ? pick.agentId : undefined;

  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" width={24} borderStyle="single" border title="Rôles">
        {roles.length === 0 ? <text fg="gray">(aucun rôle — "n" pour en créer un)</text> : null}
        {roles.map((r, index) => (
          <text key={r.name} fg={index === clampedRoleIndex ? (focus === "roles" ? "cyan" : "white") : "gray"}>
            {(index === clampedRoleIndex ? "› " : "  ") + r.name}
          </text>
        ))}
        {editing?.kind === "new-role" ? (
          <box marginTop={1}>
            <text>Nom : </text>
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
      </box>

      <box flexDirection="column" flexGrow={1} marginLeft={1} borderStyle="single" border title={role ? role.name : "Aucun rôle"}>
        {!role ? (
          <text fg="gray">Sélectionnez ou créez un rôle.</text>
        ) : (
          FIELDS.map((field, index) => {
            const isFieldSelected = focus !== "roles" && index === fieldIndex;
            return (
              <box key={field} flexDirection="column" marginBottom={field === "agents" ? 0 : 1}>
                <text fg={isFieldSelected ? "cyan" : "white"} attributes={TextAttributes.BOLD}>
                  {(isFieldSelected ? "› " : "  ") + FIELD_LABELS[field]}
                </text>
                {field === "purpose" && editing?.kind === "purpose" ? (
                  <input
                    focused
                    value={editing.buffer}
                    onInput={(value) => setEditing({ kind: "purpose", buffer: value })}
                    onSubmit={commitEdit}
                    onKeyDown={(key) => {
                      if (key.name === "escape") setEditingAndNotifyApp(null);
                    }}
                  />
                ) : field === "purpose" ? (
                  <text>  {role.purpose || "(non précisée)"}</text>
                ) : null}

                {field === "mode" ? <text>  {role.mode}</text> : null}
                {field === "isolation" ? <text>  {role.isolation}</text> : null}

                {field === "timeout" && editing?.kind === "timeout" ? (
                  <input
                    focused
                    value={editing.buffer}
                    onInput={(value) => setEditing({ kind: "timeout", buffer: value })}
                    onSubmit={commitEdit}
                    onKeyDown={(key) => {
                      if (key.name === "escape") setEditingAndNotifyApp(null);
                    }}
                  />
                ) : field === "timeout" ? (
                  <text>  {formatMs(role.timeout_ms)}</text>
                ) : null}

                {field === "system_prompt_file" && editing?.kind === "system_prompt_file" ? (
                  <input
                    focused
                    value={editing.buffer}
                    placeholder="(aucun)"
                    onInput={(value) => setEditing({ kind: "system_prompt_file", buffer: value })}
                    onSubmit={commitEdit}
                    onKeyDown={(key) => {
                      if (key.name === "escape") setEditingAndNotifyApp(null);
                    }}
                  />
                ) : field === "system_prompt_file" ? (
                  <text>  {role.system_prompt_file ?? "(aucun)"}</text>
                ) : null}

                {field === "agents" ? (
                  <box flexDirection="column" marginLeft={2}>
                    <text fg="gray">
                      Retenu aujourd'hui :{" "}
                      {pickedAgentId ?? (pick && "error" in pick ? pick.error : installed === null ? "(détection en cours…)" : "(aucun)")}
                    </text>
                    {role.agents.length === 0 ? <text fg="gray">(vide — "a" pour ajouter un agent)</text> : null}
                    {role.agents.map((agentId, index) => {
                      const isAgentSelected = focus === "agents" && index === agentIndex;
                      const isPicked = agentId === pickedAgentId;
                      const presence = installed === null ? "…" : installed.get(agentId) ? "installé" : "absent";
                      return (
                        <text key={`${agentId}-${index}`} fg={isAgentSelected ? "cyan" : isPicked ? "green" : "white"}>
                          {(isAgentSelected ? "› " : "  ") + `${index + 1}. ${agentId} (${presence})` + (isPicked ? "  ← retenu" : "")}
                        </text>
                      );
                    })}
                  </box>
                ) : null}
              </box>
            );
          })
        )}
      </box>
    </box>
  );
}
