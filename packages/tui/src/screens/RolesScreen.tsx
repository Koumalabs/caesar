/**
 * Écran Rôles : la liste des rôles à gauche, l'édition du rôle sélectionné à
 * droite — nom, intention, agents dans leur ordre de repli, mode, isolation,
 * délai, et **le prompt système lui-même**, contenu compris.
 *
 * Ce dernier point est la raison de la réécriture : le champ n'exposait
 * qu'un chemin de fichier, alors que ce fichier *est* le prompt de l'agent
 * pour ce rôle (`resolveRole` le place en tête du contexte, voir
 * `delegation.ts`). Un aperçu le montre sur place, `Entrée` l'ouvre en
 * plein écran (`PromptEditor`).
 *
 * L'ordre des agents reste le cœur de l'écran : réordonnable, avec l'agent
 * retenu aujourd'hui calculé par `pickAgentForRoleName` (`config-state.ts`,
 * qui s'appuie sur `pickAgentForRole` de `@orch/core` — la seule règle de
 * repli, jamais réécrite ici).
 *
 * Navigation à trois niveaux, et le panneau qui reçoit les touches est celui
 * dont la bordure est allumée (`Panel`, `focused`) — l'ancienne version
 * laissait deux curseurs "›" visibles sans dire lequel écoutait :
 *  - "roles"  : Haut/Bas choisit le rôle, "n" en crée un, "x" supprime,
 *               Entrée entre dans les champs.
 *  - "fields" : Haut/Bas choisit un champ, Entrée l'édite / le fait cycler /
 *               ouvre l'éditeur de prompt, Échap revient à la liste.
 *  - "agents" : Haut/Bas choisit un agent du repli, Maj+J/Maj+K le déplace,
 *               "a" en ajoute un, "r" le retire, Échap revient aux champs.
 *
 * Chaque rôle affiché est la version **effective** (la fusion, pas ce que la
 * couche active déclare seule). Renommer et supprimer restent réservés à un
 * rôle que la couche active déclare elle-même : la fusion par clé ne sait
 * exprimer ni la suppression ni le changement de nom d'une entrée héritée —
 * l'ancien nom continuerait d'exister, venu de la couche du dessous.
 */
import { useEffect, useState } from "react";
import type { RoleConfig } from "@orch/core";
import { parseDuration } from "@orch/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { catalogIds, ISOLATION_OPTIONS, MODE_OPTIONS, cycle, formatMs } from "./shared";
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
  /** `null` tant que la détection d'installation n'a pas répondu (voir `App`). */
  installed: Map<string, boolean> | null;
  onChange: (next: ConfigState) => void;
  /** Signale à `App` qu'une saisie ou l'éditeur de prompt possède le clavier. */
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

type Field_ = "name" | "purpose" | "agents" | "mode" | "isolation" | "timeout" | "prompt";
const FIELDS: Field_[] = ["name", "purpose", "agents", "mode", "isolation", "timeout", "prompt"];
const FIELD_LABELS: Record<Field_, string> = {
  name: "Nom",
  purpose: "Intention",
  agents: "Agents",
  mode: "Mode",
  isolation: "Isolation",
  timeout: "Délai",
  prompt: "Prompt système",
};

/** Ce que fait le champ, montré seulement quand on s'arrête dessus — la moitié de ces réglages n'était explicitée nulle part. */
const FIELD_HINTS: Record<Field_, string> = {
  name: 'Le nom écrit dans "orch run --role" et dans les sous-agents Claude Code.',
  purpose: "À quoi sert ce rôle. Repris tel quel par « orch role list ».",
  agents: "Ordre de repli : le premier agent installé et autorisé est retenu.",
  mode: 'read-only : l\'agent ne doit rien modifier. write : il peut écrire.',
  isolation: "worktree : copie de travail jetable. inplace : le dépôt lui-même. auto : worktree en écriture, et pour toute lecture seule sans mode natif.",
  timeout: 'Au-delà, la tâche est interrompue. Formes acceptées : "10m", "90s", "1h".',
  prompt: "Le texte placé en tête du contexte de l'agent, avant l'objectif. Entrée : l'éditer.",
};

const LABEL_WIDTH = 15;
/** Panneau de gauche : assez pour un nom de rôle, pas plus — la place appartient à l'édition. */
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

  // Aperçu du prompt : rechargé quand le rôle ou son chemin change, jamais à
  // chaque frappe. Une lecture qui échoue laisse l'aperçu vide plutôt que de
  // bloquer l'écran — le chemin, lui, reste affiché.
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
      // Un rôle sans prompt déclaré : plutôt que de refuser, on propose le
      // chemin conventionnel (celui qu'`orch init` écrit) et on le pose comme
      // modification en attente. Le fichier, lui, ne naîtra qu'à Ctrl+S.
      const file = defaultPromptFileFor(role.name);
      onChange(updateRole(state, role.name, { system_prompt_file: file }));
      notify(`Prompt du rôle "${role.name}" à créer : ${file}. Écrivez-le, puis Ctrl+S — et "s" pour enregistrer le chemin dans la configuration.`);
    }
    setPromptOpen(true);
    onEditingChange(true);
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
      notify(replaced ? `Rôle "${name}" remplacé.` : `Rôle "${name}" créé — Entrée pour le décrire.`);
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
        notify("Le nom du rôle ne peut pas être vide.", true);
        return;
      }
      if (roles.some((r) => r.name === name)) {
        notify(`Un rôle "${name}" existe déjà.`, true);
        return;
      }
      if (!roleDeclaredByActiveLayer(state, role.name)) {
        notify(
          `"${role.name}" n'est pas déclaré par la couche active${formatInheritedMark(roleMark(state, role.name))} : le renommer ici laisserait l'ancien nom vivre dans la couche dont il vient. Changez de portée (p) pour le renommer là où il est déclaré.`,
          true,
        );
        return;
      }
      onChange(renameRole(state, role.name, name));
      notify(`Rôle renommé "${name}".`);
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
    if (editing || promptOpen) return; // Une saisie ou l'éditeur possède le clavier.

    if (focus === "roles") {
      if (key.name === "up" || key.name === "k") setRoleIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down" || key.name === "j") setRoleIndex((i) => Math.min(roles.length - 1, i + 1));
      else if (key.name === "n") setEditingAndNotifyApp({ kind: "new-role", buffer: "" });
      else if (key.name === "x" && role) {
        if (!roleDeclaredByActiveLayer(state, role.name)) {
          notify(
            `"${role.name}" n'est pas déclaré par la couche active${formatInheritedMark(roleMark(state, role.name))} : rien à supprimer ici. Modifiez-le (Entrée) pour le redéfinir sur cette couche, ou changez de portée (p) pour éditer la couche dont il vient.`,
            true,
          );
          return;
        }
        onChange(removeRole(state, role.name));
        notify(`Rôle "${role.name}" supprimé.`);
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
    // Les deux gestes "Maj" passent avant leurs homologues sans modificateur :
    // une frappe Maj+K porte `name === "k"`, elle serait donc absorbée par le
    // déplacement de curseur si celui-ci était testé en premier — le
    // réordonnancement, geste central de cet écran, ne marcherait plus.
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
      else notify("Tous les agents du catalogue sont déjà dans la liste.", true);
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
  // Bordures et retraits du panneau de droite : 2 bordures + 2 espaces de
  // remplissage, plus la largeur du panneau de gauche et la marge entre eux.
  const detailWidth = Math.max(30, width - LIST_WIDTH - 1 - 4 - 2);

  const hints: Hint[] =
    focus === "roles"
      ? [
          { key: "↑↓", label: "rôle" },
          { key: "Entrée", label: "éditer" },
          { key: "n", label: "nouveau" },
          { key: "x", label: "supprimer" },
        ]
      : focus === "fields"
        ? [
            { key: "↑↓", label: "champ" },
            { key: "Entrée", label: FIELDS[fieldIndex] === "prompt" ? "éditer le prompt" : "modifier" },
            ...(FIELDS[fieldIndex] === "prompt" ? [{ key: "f", label: "changer le fichier" }] : []),
            { key: "Échap", label: "revenir aux rôles" },
          ]
        : [
            { key: "↑↓", label: "agent" },
            { key: "Maj+J/K", label: "déplacer" },
            { key: "a", label: "ajouter" },
            { key: "r", label: "retirer" },
            { key: "Échap", label: "revenir aux champs" },
          ];

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        <Panel title="Rôles" focused={focus === "roles"} width={LIST_WIDTH}>
          {roles.length === 0 ? <text fg={DIM}>(aucun — "n")</text> : null}
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
              <text fg={ACCENT}>Nom :</text>
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
            title={role ? role.name : "Aucun rôle"}
            focused={focus !== "roles"}
            flexGrow={1}
            note={
              !role
                ? undefined
                : declaredHere
                  ? "Déclaré par la couche active."
                  : `Hérité${formatInheritedMark(roleMark(state, role.name))} — le modifier le redéfinira sur la couche active.`
            }
          >
            {!role ? (
              <text fg={DIM}>Sélectionnez un rôle, ou créez-en un avec "n".</text>
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
                    <Field key={field} {...common} value={role.purpose || "(non précisée)"} valueFg={role.purpose ? undefined : DIM} />
                  );
                }

                if (field === "mode") return <Field key={field} {...common} value={role.mode} />;
                if (field === "isolation") return <Field key={field} {...common} value={role.isolation} />;

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
                  const retenu =
                    pickedAgentId ??
                    (pick && "error" in pick ? "aucun — voir ci-dessous" : installed === null ? "(détection en cours…)" : "(aucun)");
                  return (
                    <Field
                      key={field}
                      {...common}
                      value={retenu}
                      valueFg={pickedAgentId ? OK : WARN}
                      below={
                        <box flexDirection="column" marginLeft={LABEL_WIDTH + 2}>
                          {role.agents.length === 0 ? <text fg={DIM}>(vide — "a" pour ajouter un agent)</text> : null}
                          {role.agents.map((agentId, agentPos) => {
                            const isAgentSelected = focus === "agents" && agentPos === agentIndex;
                            const isPicked = agentId === pickedAgentId;
                            const presence = installed === null ? "…" : installed.get(agentId) ? "installé" : "absent";
                            return (
                              <text
                                key={`${agentId}-${agentPos}`}
                                fg={isAgentSelected ? ACCENT : isPicked ? OK : installed?.get(agentId) === false ? DIM : undefined}
                              >
                                {(isAgentSelected ? "› " : "  ") +
                                  `${agentPos + 1}. ${agentId} (${presence})` +
                                  (isPicked ? "  ← retenu" : "")}
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
                      placeholder="(aucun — chemin relatif sous .orch/)"
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
                        ? `${role.system_prompt_file}${preview ? (preview.exists ? ` — ${preview.bytes} caractères` : " — à créer") : ""}`
                        : "(aucun — Entrée pour en écrire un)"
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
