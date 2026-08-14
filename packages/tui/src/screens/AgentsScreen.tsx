/**
 * Écran Agents : le catalogue en tableau, et le détail de l'agent
 * sélectionné en dessous — présence, version, capacités, autorisation, rôles
 * qui l'emploient, et pour un agent **déclaré** (`[[agent]]`) ses champs
 * éditables.
 *
 * Deux gestes bien distincts, et l'écran doit le rester : `Espace` autorise
 * ou refuse (une liste de la politique), `n` déclare un CLI que le catalogue
 * natif ne connaît pas (une entrée `[[agent]]` qui étend le catalogue).
 * Confondre les deux serait le contresens le plus facile à commettre ici.
 *
 * Ce que la réécriture corrige, tout venu de l'usage :
 *  - les colonnes se touchaient (largeurs constantes, aucune gouttière) :
 *    un chemin tronqué et la version voisine se lisaient comme un seul mot.
 *    `Table` calcule désormais les largeurs sur la place réelle ;
 *  - « 7 notable(s) » remplaçait les capacités par leur décompte. Le tableau
 *    les nomme (`describeAgentCapabilitiesShort`), le détail les développe ;
 *  - le motif d'un refus partait hors de l'écran sur une ligne unique : il
 *    est replié dans le panneau de détail ;
 *  - le chemin du binaire occupait une colonne alors qu'il ne sert qu'une
 *    fois qu'on s'intéresse à un agent précis — même leçon que `caesar doctor`,
 *    qui l'a sorti de sa vue par défaut. Il vit maintenant dans le détail.
 *
 * Capacités et statut vis-à-vis de la politique viennent de
 * `describeAgentCapabilities`/`describeAgentPolicy` (`@caesar/core`) — la même
 * logique que `caesar doctor`/`caesar agents list`, réutilisée telle quelle. La
 * détection d'installation est calculée une seule fois par `App` : cet écran
 * ne fait qu'afficher `installed`, jamais la relancer.
 *
 * Deux niveaux de navigation :
 *  - "list"   : Haut/Bas choisit l'agent, Espace bascule l'autorisation,
 *               `n` déclare (identifiant saisi en ligne), `x` retire une
 *               déclaration, Entrée entre dans les champs d'un agent déclaré.
 *  - "fields" : Haut/Bas choisit un champ, Entrée l'édite ou le fait
 *               basculer, Échap revient à la liste.
 *
 * Chaque modification est une modification en attente sur la couche active,
 * comme partout ailleurs dans ce TUI : rien n'est écrit avant "s".
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
  policyFieldMark,
  removeAgentSpec,
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
  /** `null` tant que la détection n'a pas encore répondu — voir `App`. */
  installed: Map<string, AgentInstallStatus> | null;
  onToggleDenied: (agentId: string) => void;
  onChange: (next: ConfigState) => void;
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

type Field_ = "displayName" | "bin" | "args" | "networkArgs" | "cwdMode" | "nativeReadOnly";
const FIELDS: Field_[] = ["displayName", "bin", "args", "networkArgs", "cwdMode", "nativeReadOnly"];
const FIELD_LABELS: Record<Field_, string> = {
  displayName: "Nom affiché",
  bin: "Binaire",
  args: "Arguments",
  networkArgs: "Arguments réseau",
  cwdMode: "Répertoire",
  nativeReadOnly: "Lecture seule",
};
const FIELD_HINTS: Record<Field_, string> = {
  displayName: "Comment cet agent s'annonce dans les listes. À défaut, son identifiant.",
  bin: "La commande à lancer. Un chemin (avec un « / ») désigne un fichier ; un nom seul est cherché dans le PATH.",
  args: `Gabarit de ligne de commande. Jetons : ${GENERIC_ARG_TOKENS.map((name) => `{{${name}}}`).join(" ")}. Un argument dont un jeton n'a pas de valeur disparaît entièrement.`,
  networkArgs:
    "Ce qu'il faut ajouter pour ouvrir le réseau, p. ex. --allow-all-urls. Les déclarer, c'est affirmer que sans eux ce CLI est confiné — sinon caesar annonce « réseau inconnu » et ne promet rien.",
  cwdMode: "process : le répertoire courant porte le workspace. flag : il est déjà passé en argument.",
  nativeReadOnly: "Le CLI garantit-il lui-même de ne rien écrire ? Sinon, une tâche en lecture seule est isolée dans un worktree.",
};

const CWD_MODES = ["process", "flag"] as const;
const LABEL_WIDTH = 14;

/** Le gabarit d'arguments tel qu'on l'édite : une ligne de commande, pas une liste. */
function argsLine(spec: GenericAgentSpec): string {
  return formatArgTemplate(spec.args);
}

function networkArgsLine(spec: GenericAgentSpec): string {
  return formatArgTemplate(spec.networkArgs ?? []);
}

export function AgentsScreen({ state, installed, onToggleDenied, onChange, onEditingChange, notify }: AgentsScreenProps) {
  const { width } = useTerminalDimensions();
  const config = effectiveConfig(state);
  // Catalogue natif étendu des agents de configuration (`config.agents`,
  // `[[agent]]` du TOML, fusion effective) : recalculé à chaque rendu, sinon
  // un agent nouvellement déclaré n'apparaîtrait jamais (C1 de la revue
  // finale). Un agent déclaré pour lequel la détection n'a pas tourné
  // affiche honnêtement "…" plutôt qu'un faux "absent".
  const CATALOG = listAgentDefinitions(config.agents);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState<"list" | "fields">("list");
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editing, setEditing] = useState<{ kind: "new-agent" | "displayName" | "bin" | "args" | "networkArgs"; buffer: string } | null>(null);

  const deniedMark = formatInheritedMark(policyFieldMark(state, "denied"));
  const allowedMark = formatInheritedMark(policyFieldMark(state, "allowed"));

  const clamped = Math.min(selected, Math.max(0, CATALOG.length - 1));
  const def = CATALOG[clamped];
  const spec = def ? findAgentSpec(state, def.id) : undefined;
  // Bordures et remplissage du panneau, plus la marge d'`App`.
  const panelWidth = Math.max(30, width - 6);

  function setEditingAndNotifyApp(next: typeof editing): void {
    setEditing(next);
    onEditingChange(next !== null);
  }

  /**
   * Applique un changement de déclaration après validation. La validation ne
   * porte pas seulement sur la saisie du moment : un gabarit d'arguments et
   * un binaire se valident ensemble (`validateGenericAgentSpec`), donc c'est
   * la déclaration entière qu'on soumet, telle qu'elle serait après ce
   * changement. Rien n'est modifié si elle ne tient pas.
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
      // Déclaration minimale mais immédiatement valide : le binaire vaut
      // l'identifiant (le cas le plus fréquent — `aider` se lance par
      // `aider`), et le gabarit se réduit au seul jeton obligatoire. Les
      // champs s'affinent ensuite dans le panneau, comme pour un rôle.
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
          ? `Agent "${id}" redéclaré — cette déclaration remplace l'agent du même identifiant.`
          : `Agent "${id}" déclaré. Ajustez son binaire et ses arguments, puis "s" pour enregistrer.`,
      );
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
      // Une liste vide n'est pas « aucun argument réseau déclaré » : elle
      // ferait passer la capacité à "toggle" sans rien ouvrir. Absente, elle
      // laisse honnêtement « réseau inconnu ».
      if (networkArgs.length === 0) delete next.networkArgs;
      else next.networkArgs = networkArgs;
      if (!applySpec(next)) return;
    }
    setEditingAndNotifyApp(null);
  }

  useKeyboard((key) => {
    if (editing) return; // Le champ texte affiché plus bas possède le focus et gère lui-même ses touches.

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
          // Ne jamais laisser `capabilities: { nativeReadOnly: false }` dans
          // le TOML : une capacité fausse explicitement écrite se lit comme
          // une décision, alors qu'elle est le défaut.
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
    } else if (key.name === "x") {
      if (!def) return;
      if (!spec) {
        notify(
          `"${def.id}" appartient au catalogue natif : il n'y a pas de déclaration à retirer. Pour l'écarter des délégations, utilisez Espace (autorisation).`,
          true,
        );
        return;
      }
      if (!agentDeclaredByActiveLayer(state, def.id)) {
        notify(
          `"${def.id}" n'est pas déclaré par la couche active${formatInheritedMark(agentMark(state, def.id))} : rien à retirer ici. Changez de portée (p) pour éditer la couche dont il vient.`,
          true,
        );
        return;
      }
      onChange(removeAgentSpec(state, def.id));
      notify(`Déclaration de "${def.id}" retirée.`);
      setSelected((i) => Math.max(0, Math.min(i, CATALOG.length - 2)));
    } else if (key.name === "return") {
      if (!def) return;
      if (spec) {
        setFieldIndex(0);
        setFocus("fields");
      } else {
        notify(`"${def.id}" est un agent du catalogue natif : ses champs ne se modifient pas. "n" déclare un CLI hors catalogue.`);
      }
    }
  });

  const presenceOf = (agent: AgentDefinition): string => {
    const status = installed?.get(agent.id);
    if (status === undefined) return "…";
    if (!status.installed) return "absent";
    return status.version ?? "installé";
  };

  // La colonne variable passe en dernier : le bord irrégulier tombe alors à
  // droite de l'écran, et non entre deux colonnes qu'on voudrait aligner.
  const columns: Array<TableColumn<AgentDefinition>> = [
    {
      header: "agent",
      min: 16,
      cell: (agent) => agent.id + (config.agents.some((a) => a.id === agent.id) ? " *" : ""),
    },
    {
      // Une version de CLI est verbeuse ("2.1.227 (Claude Code)") : cette
      // colonne prend sa part de la place libre plutôt que de la tronquer
      // pendant qu'un terminal large reste à moitié vide.
      header: "état",
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
      header: "autorisation",
      min: 14,
      cell: (agent) => (describeAgentPolicy(config.policy, agent.id).allowed ? "autorisé" : "refusé"),
      fg: (agent) => (describeAgentPolicy(config.policy, agent.id).allowed ? OK : BAD),
    },
    { header: "capacités", min: 24, flex: 2, max: 46, cell: (agent) => describeAgentCapabilitiesShort(agent).join(" ") || "—" },
  ];

  const policy = def ? describeAgentPolicy(config.policy, def.id) : null;
  const status = def ? installed?.get(def.id) : undefined;
  const usedBy = def
    ? config.roles
        .map((role) => ({ role, rank: role.agents.indexOf(def.id) }))
        .filter((entry) => entry.rank >= 0)
        .map((entry) => `${entry.role.name} (${entry.rank + 1}${entry.rank === 0 ? "er" : "e"})`)
    : [];

  const hints: Hint[] =
    focus === "list"
      ? [
          { key: "↑↓", label: "agent" },
          { key: "Espace", label: "autoriser / refuser" },
          { key: "n", label: "déclarer un CLI" },
          ...(spec ? [{ key: "Entrée", label: "éditer" }, { key: "x", label: "retirer la déclaration" }] : []),
        ]
      : [
          { key: "↑↓", label: "champ" },
          { key: "Entrée", label: "modifier" },
          { key: "Échap", label: "revenir à la liste" },
        ];

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title="Catalogue" focused={focus === "list"}>
        <Table
          columns={columns}
          rows={CATALOG}
          keyOf={(agent) => agent.id}
          selectedIndex={clamped}
          focused={focus === "list"}
          width={panelWidth}
        />
        {installed === null ? <text fg={WARN}>Détection de l'installation en cours…</text> : null}
        {config.agents.length > 0 ? <text fg={FAINT}>* déclaré en configuration</text> : null}
        {deniedMark ? <text fg={FAINT}>{`"denied" hérité${deniedMark} — Espace le prend en charge sur la couche active.`}</text> : null}
        {allowedMark ? <text fg={FAINT}>{`"allowed" hérité${allowedMark} — le modifier le prendra en charge sur la couche active.`}</text> : null}
      </Panel>

      {editing?.kind === "new-agent" ? (
        <Panel title="Déclarer un agent" focused note="Identifiant — celui qu'on écrira dans « caesar run --agent » et dans les rôles.">
          <box flexDirection="row">
            <text>{"Identifiant   "}</text>
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
      ) : def ? (
        <Panel
          title={def.displayName === def.id ? def.id : `${def.id} — ${def.displayName}`}
          focused={focus === "fields"}
          note={
            spec
              ? agentDeclaredByActiveLayer(state, def.id)
                ? "Déclaré par la couche active — Entrée pour éditer ses champs."
                : `Déclaré${formatInheritedMark(agentMark(state, def.id))} — le modifier le redéfinira sur la couche active.`
              : "Agent du catalogue natif : câblé dans l'orchestrateur, ses champs ne se modifient pas."
          }
        >
          {spec ? (
            <>
              <Field
                label="Commande"
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
                        placeholder="(l'identifiant)"
                        onInput={(value) => setEditing({ kind: "displayName", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                    </Field>
                  ) : (
                    <Field key={field} {...common} value={spec.displayName ?? `(l'identifiant : ${def.id})`} valueFg={spec.displayName ? undefined : DIM} />
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
                    <Field key={field} {...common} value={networkArgsLine(spec) || "(aucun — réseau inconnu)"} />
                  );
                }

                if (field === "cwdMode") {
                  return <Field key={field} {...common} value={spec.cwdMode ?? "process"} />;
                }

                return (
                  <Field
                    key={field}
                    {...common}
                    value={spec.capabilities?.nativeReadOnly ? "oui" : "non"}
                    valueFg={spec.capabilities?.nativeReadOnly ? OK : undefined}
                  />
                );
              })}
            </>
          ) : (
            <>
              <Field label="Binaire" width={panelWidth} labelWidth={LABEL_WIDTH} value={def.bin} />
              <Field
                label="Trouvé"
                width={panelWidth}
                labelWidth={LABEL_WIDTH}
                value={status === undefined ? "détection en cours…" : (status.path ?? "absent du PATH")}
                valueFg={status === undefined ? DIM : status.installed ? OK : WARN}
              />
              <Field
                label="Version"
                width={panelWidth}
                labelWidth={LABEL_WIDTH}
                value={status?.version ?? (status?.installed ? "inconnue" : "—")}
              />
              <Field
                label="Capacités"
                width={panelWidth}
                labelWidth={LABEL_WIDTH}
                value={describeAgentCapabilities(def).join(", ") || "(aucune capacité notable)"}
              />
            </>
          )}

          {policy ? (
            <Field
              label="Autorisation"
              width={panelWidth}
              labelWidth={LABEL_WIDTH}
              value={policy.allowed ? "autorisé" : policy.reason}
              valueFg={policy.allowed ? OK : BAD}
            />
          ) : null}
          <Field
            label="Employé par"
            width={panelWidth}
            labelWidth={LABEL_WIDTH}
            value={usedBy.length > 0 ? usedBy.join(", ") : "aucun rôle"}
            valueFg={usedBy.length > 0 ? undefined : DIM}
          />
          {focus === "fields" ? <Explain text={FIELD_HINTS[FIELDS[fieldIndex]!]} width={panelWidth} /> : null}
        </Panel>
      ) : (
        <text fg={ACCENT}>Aucun agent — "n" pour en déclarer un.</text>
      )}

      {/* `marginTop: "auto"` colle la barre au bas du corps : les panneaux
          gardent la hauteur de leur contenu, sans cadre à moitié vide. */}
      <box marginTop="auto" paddingTop={1}>
        <KeyHints hints={hints} />
      </box>
    </box>
  );
}
