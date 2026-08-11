/**
 * Écran Agents : catalogue natif, présence, version, capacités notables,
 * autorisation — et la **déclaration** d'agents hors catalogue (`[[agent]]`).
 *
 * Deux gestes bien distincts, et l'écran doit le rester : `Espace` autorise
 * ou refuse (une liste de la politique), `n` déclare un CLI que le catalogue
 * natif ne connaît pas (une entrée `[[agent]]` qui étend le catalogue).
 * Confondre les deux serait le contresens le plus facile à commettre ici.
 *
 * Capacités et statut vis-à-vis de la politique viennent de
 * `describeAgentCapabilities`/`describeAgentPolicy` (`@orch/core`,
 * `registry/index.ts`/`policy.ts`) — la même logique que `orch doctor`/
 * `orch agents list` affichent (`packages/cli/src/commands/{doctor,agents}.ts`),
 * réutilisée telle quelle plutôt que recopiée (voir le brief). Importées
 * directement d'`@orch/core` (et non de `packages/cli`, qui les appelle
 * elles aussi) : voir le rapport de correction de la tâche 8. La détection
 * d'installation, elle, est asynchrone et déjà calculée par `App` (une
 * seule fois, jamais à chaque frappe) : cet écran ne fait qu'afficher
 * `installed`, jamais la relancer lui-même.
 *
 * `policy.denied`/`allowed` se matérialisent en entier (voir
 * `setPolicyListEntry`, `config-state.ts`) : leur provenance est donc un
 * champ, pas une ligne — une seule marque d'héritage au-dessus du tableau
 * suffit (tâche 15), plutôt que d'encombrer chaque ligne.
 *
 * Deux niveaux de navigation, comme `RolesScreen` :
 *  - "list"   : Haut/Bas choisit l'agent, Espace bascule l'autorisation,
 *               `n` déclare (identifiant saisi en ligne), `x` retire une
 *               déclaration, Entrée déplie le détail — et, sur un agent
 *               déclaré, entre dans "fields".
 *  - "fields" : Haut/Bas choisit un champ de la déclaration, Entrée l'édite
 *               (texte) ou le fait basculer (répertoire courant, lecture
 *               seule native), Échap revient à "list".
 *
 * Chaque modification est une modification en attente sur la couche active,
 * comme partout ailleurs dans ce TUI : rien n'est écrit avant "s".
 */
import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
  GENERIC_ARG_TOKENS,
  describeAgentCapabilities,
  describeAgentPolicy,
  formatArgTemplate,
  listAgentDefinitions,
  splitArgTemplate,
  validateGenericAgentSpec,
} from "@orch/core";
import type { AgentInstallStatus, GenericAgentSpec } from "@orch/core";
import {
  agentDeclaredByActiveLayer,
  agentMark,
  effectiveConfig,
  findAgentSpec,
  formatInheritedMark,
  policyFieldMark,
  removeAgentSpec,
  updateAgentSpec,
  upsertAgentSpec,
  type ConfigState,
} from "../state/config-state";
import { cycle, fitColumn } from "./shared";

export interface AgentsScreenProps {
  state: ConfigState;
  /** `null` tant que la détection n'a pas encore répondu — voir `App`. */
  installed: Map<string, AgentInstallStatus> | null;
  onToggleDenied: (agentId: string) => void;
  onChange: (next: ConfigState) => void;
  onEditingChange: (editing: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

type Field = "displayName" | "bin" | "args" | "cwdMode" | "nativeReadOnly";
const FIELDS: Field[] = ["displayName", "bin", "args", "cwdMode", "nativeReadOnly"];
const FIELD_LABELS: Record<Field, string> = {
  displayName: "Nom affiché",
  bin: "Binaire",
  args: "Arguments",
  cwdMode: "Répertoire courant",
  nativeReadOnly: "Lecture seule native",
};

const CWD_MODES = ["process", "flag"] as const;
const TOKENS_HINT = GENERIC_ARG_TOKENS.map((name) => `{{${name}}}`).join(" ");

/** Le gabarit d'arguments tel qu'on l'édite : une ligne de commande, pas une liste. */
function argsLine(spec: GenericAgentSpec): string {
  return formatArgTemplate(spec.args);
}

export function AgentsScreen({ state, installed, onToggleDenied, onChange, onEditingChange, notify }: AgentsScreenProps) {
  const config = effectiveConfig(state);
  // Catalogue natif étendu des agents de configuration (`config.agents`,
  // `[[agent]]` du TOML, fusion effective) — même correction que `shared.ts`
  // (`catalogIds`, voir C1 de la revue finale) : cette liste vivait jusqu'ici
  // en constante de module, figée à `listAgentDefinitions()` sans argument au
  // premier chargement, et ne pouvait donc jamais afficher un agent de
  // configuration. Un agent nouvellement configuré sans détection encore
  // lancée pour lui (`installed` n'en a pas d'entrée) affiche honnêtement
  // "…" plutôt qu'un faux "absent" — limite résiduelle documentée dans le
  // rapport de cette vague plutôt que résolue ici (`App` ne détecte
  // l'installation qu'une seule fois, sans dépendre du chargement de la
  // configuration).
  const CATALOG = listAgentDefinitions(config.agents);
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [focus, setFocus] = useState<"list" | "fields">("list");
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editing, setEditing] = useState<{ kind: "new-agent" | "displayName" | "bin" | "args"; buffer: string } | null>(null);

  const deniedMark = formatInheritedMark(policyFieldMark(state, "denied"));
  const allowedMark = formatInheritedMark(policyFieldMark(state, "allowed"));

  const clamped = Math.min(selected, Math.max(0, CATALOG.length - 1));
  const def = CATALOG[clamped];
  const spec = def ? findAgentSpec(state, def.id) : undefined;

  function setEditingAndNotifyApp(next: typeof editing): void {
    setEditing(next);
    onEditingChange(next !== null);
  }

  /**
   * Applique un changement de déclaration après validation. La validation ne
   * porte pas seulement sur la saisie du moment : un gabarit d'arguments et
   * un binaire se valident ensemble (voir `validateGenericAgentSpec`), donc
   * c'est la déclaration entière qu'on soumet, telle qu'elle serait après ce
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
          : `Agent "${id}" déclaré. Ajustez son binaire et ses arguments ci-dessous, puis "s" pour enregistrer.`,
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
      else if (key.name === "up") setFieldIndex((i) => Math.max(0, i - 1));
      else if (key.name === "down") setFieldIndex((i) => Math.min(FIELDS.length - 1, i + 1));
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
        const mark = formatInheritedMark(agentMark(state, def.id));
        notify(
          `"${def.id}" n'est pas déclaré par la couche active${mark} : rien à retirer ici. Changez de portée (p) pour éditer la couche dont il vient.`,
          true,
        );
        return;
      }
      onChange(removeAgentSpec(state, def.id));
      notify(`Déclaration de "${def.id}" retirée.`);
      setSelected((i) => Math.max(0, Math.min(i, CATALOG.length - 2)));
      setExpanded(null);
    } else if (key.name === "return") {
      if (!def) return;
      if (spec) {
        setFieldIndex(0);
        setFocus("fields");
      } else {
        setExpanded((current) => (current === def.id ? null : def.id));
      }
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg="gray">
        Espace : autorisation · n : déclarer un agent hors catalogue · x : retirer une déclaration · Entrée : détail / édition
      </text>
      {deniedMark ? <text fg="gray">"denied" hérité{deniedMark} — Espace le prend en charge sur la couche active.</text> : null}
      {allowedMark ? <text fg="gray">"allowed" hérité{allowedMark} — le modifier le prendra en charge sur la couche active.</text> : null}
      <box flexDirection="row" marginTop={1}>
        <text attributes={TextAttributes.BOLD}>{fitColumn("agent", 14)}</text>
        <text attributes={TextAttributes.BOLD}>{fitColumn("binaire", 26)}</text>
        <text attributes={TextAttributes.BOLD}>{fitColumn("version", 14)}</text>
        <text attributes={TextAttributes.BOLD}>{fitColumn("capacités", 14)}</text>
        <text attributes={TextAttributes.BOLD}>autorisation</text>
      </box>
      <box flexDirection="column">
        {CATALOG.map((agent, index) => {
          const isSelected = index === clamped;
          const status = installed?.get(agent.id);
          const presence = status === undefined ? "…" : status.installed ? (status.path ?? "trouvé") : "absent";
          const version = status?.version ?? (status?.installed ? "?" : "-");
          const policy = describeAgentPolicy(config.policy, agent.id);
          const policyText = policy.allowed ? "autorisé" : `refusé (${policy.reason})`;
          const caps = describeAgentCapabilities(agent);
          const capsSummary = caps.length > 0 ? `${caps.length} notable(s)` : "aucune";
          const declared = config.agents.some((a) => a.id === agent.id);

          return (
            <box key={agent.id} flexDirection="column">
              <box flexDirection="row" backgroundColor={isSelected ? "#333366" : undefined}>
                <text>{(isSelected ? "› " : "  ") + fitColumn(agent.id + (declared ? " *" : ""), 12)}</text>
                <text>{fitColumn(presence, 26)}</text>
                <text>{fitColumn(version, 14)}</text>
                <text>{fitColumn(capsSummary, 14)}</text>
                <text fg={policy.allowed ? "green" : "red"}>{policyText}</text>
              </box>
              {expanded === agent.id ? (
                <box flexDirection="column" marginLeft={4} marginBottom={1}>
                  <text fg="gray">Capacités : {caps.length > 0 ? caps.join(", ") : "(aucune capacité notable)"}</text>
                </box>
              ) : null}
            </box>
          );
        })}
      </box>
      {installed === null ? <text fg="yellow">Détection de l'installation en cours…</text> : null}
      {config.agents.length > 0 ? <text fg="gray">{"\n* déclaré en configuration — Entrée pour l'éditer."}</text> : null}

      {editing?.kind === "new-agent" ? (
        <box flexDirection="column" marginTop={1} border borderStyle="single" title="Déclarer un agent">
          <text fg="gray">Identifiant — celui qu'on écrira dans "orch run --agent" et dans les rôles.</text>
          <box flexDirection="row">
            <text>Identifiant : </text>
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
        </box>
      ) : null}

      {spec && def && editing?.kind !== "new-agent" ? (
        <box flexDirection="column" marginTop={1} border borderStyle="single" title={`Déclaration : ${def.id}`}>
          <text fg="gray">
            {agentDeclaredByActiveLayer(state, def.id)
              ? "Déclaré par la couche active."
              : `Hérité${formatInheritedMark(agentMark(state, def.id))} — le modifier le redéfinira sur la couche active.`}
          </text>
          <text fg="gray">Ligne de commande : {spec.bin} {argsLine(spec)}</text>
          {FIELDS.map((field, index) => {
            const isFieldSelected = focus === "fields" && index === fieldIndex;
            const label = (isFieldSelected ? "› " : "  ") + FIELD_LABELS[field];
            return (
              <box key={field} flexDirection="column">
                <text fg={isFieldSelected ? "cyan" : "white"} attributes={TextAttributes.BOLD}>
                  {label}
                </text>
                {field === "displayName" ? (
                  editing?.kind === "displayName" ? (
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
                  ) : (
                    <text>  {spec.displayName ?? `(l'identifiant : ${def.id})`}</text>
                  )
                ) : null}

                {field === "bin" ? (
                  editing?.kind === "bin" ? (
                    <input
                      focused
                      value={editing.buffer}
                      onInput={(value) => setEditing({ kind: "bin", buffer: value })}
                      onSubmit={commitEdit}
                      onKeyDown={(key) => {
                        if (key.name === "escape") setEditingAndNotifyApp(null);
                      }}
                    />
                  ) : (
                    <text>  {spec.bin}</text>
                  )
                ) : null}

                {field === "args" ? (
                  editing?.kind === "args" ? (
                    <box flexDirection="column">
                      <input
                        focused
                        value={editing.buffer}
                        onInput={(value) => setEditing({ kind: "args", buffer: value })}
                        onSubmit={commitEdit}
                        onKeyDown={(key) => {
                          if (key.name === "escape") setEditingAndNotifyApp(null);
                        }}
                      />
                      <text fg="gray">  Jetons : {TOKENS_HINT}</text>
                    </box>
                  ) : (
                    <text>  {argsLine(spec)}</text>
                  )
                ) : null}

                {field === "cwdMode" ? (
                  <text>
                    {"  "}
                    {spec.cwdMode ?? "process"}
                    {(spec.cwdMode ?? "process") === "process"
                      ? " — le répertoire courant porte le workspace"
                      : " — le workspace est déjà passé en argument"}
                  </text>
                ) : null}

                {field === "nativeReadOnly" ? (
                  <text>
                    {"  "}
                    {spec.capabilities?.nativeReadOnly
                      ? "oui — une tâche en lecture seule n'a pas besoin d'un worktree"
                      : "non — une tâche en lecture seule sera isolée dans un worktree"}
                  </text>
                ) : null}
              </box>
            );
          })}
        </box>
      ) : null}
    </box>
  );
}
