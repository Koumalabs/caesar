/**
 * Écran Agents : catalogue natif, présence, version, capacités notables,
 * autorisation. `Espace` bascule l'autorisation de la ligne courante,
 * `Entrée` déplie le détail des capacités.
 *
 * Capacités et statut vis-à-vis de la politique viennent de
 * `describeAgentCapabilities`/`describeAgentPolicy` (`@orch/cli`,
 * `commands/agents.ts`) — la même logique que `orch doctor`/`orch agents
 * list` affichent, réutilisée telle quelle plutôt que recopiée (voir le
 * brief). La détection d'installation, elle, est asynchrone et déjà
 * calculée par `App` (une seule fois, jamais à chaque frappe) : cet écran
 * ne fait qu'afficher `installed`, jamais la relancer lui-même.
 */
import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { describeAgentCapabilities, describeAgentPolicy } from "@orch/cli";
import { listAgentDefinitions } from "@orch/core";
import type { ConfigState } from "../state/config-state";

export interface AgentsScreenProps {
  state: ConfigState;
  /** `null` tant que la détection n'a pas encore répondu — voir `App`. */
  installed: Map<string, { installed: boolean; path?: string; version?: string }> | null;
  onToggleDenied: (agentId: string) => void;
}

const CATALOG = listAgentDefinitions();

export function AgentsScreen({ state, installed, onToggleDenied }: AgentsScreenProps) {
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  useKeyboard((key) => {
    if (key.name === "up" || key.name === "k") setSelected((i) => Math.max(0, i - 1));
    else if (key.name === "down" || key.name === "j") setSelected((i) => Math.min(CATALOG.length - 1, i + 1));
    else if (key.name === "space") {
      const def = CATALOG[selected];
      if (def) onToggleDenied(def.id);
    } else if (key.name === "return") {
      const def = CATALOG[selected];
      if (def) setExpanded((current) => (current === def.id ? null : def.id));
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg="gray">Catalogue des agents — Espace : autorisation, Entrée : détail des capacités.</text>
      <box flexDirection="row" marginTop={1}>
        <text attributes={TextAttributes.BOLD}>{"agent".padEnd(14)}</text>
        <text attributes={TextAttributes.BOLD}>{"binaire".padEnd(28)}</text>
        <text attributes={TextAttributes.BOLD}>{"version".padEnd(16)}</text>
        <text attributes={TextAttributes.BOLD}>{"autorisation".padEnd(30)}</text>
      </box>
      <box flexDirection="column">
        {CATALOG.map((def, index) => {
          const isSelected = index === selected;
          const status = installed?.get(def.id);
          const presence = status === undefined ? "…" : status.installed ? (status.path ?? "trouvé") : "absent";
          const version = status?.version ?? (status?.installed ? "?" : "-");
          const policy = describeAgentPolicy(state.draft.policy, def.id);
          const policyText = policy.allowed ? "autorisé" : `refusé (${policy.reason})`;
          const caps = describeAgentCapabilities(def);

          return (
            <box key={def.id} flexDirection="column">
              <box flexDirection="row" backgroundColor={isSelected ? "#333366" : undefined}>
                <text>{(isSelected ? "› " : "  ") + def.id.padEnd(12)}</text>
                <text>{presence.padEnd(28)}</text>
                <text>{version.padEnd(16)}</text>
                <text fg={policy.allowed ? "green" : "red"}>{policyText}</text>
              </box>
              {expanded === def.id ? (
                <box flexDirection="column" marginLeft={4} marginBottom={1}>
                  <text fg="gray">Capacités : {caps.length > 0 ? caps.join(", ") : "(aucune capacité notable)"}</text>
                </box>
              ) : null}
            </box>
          );
        })}
      </box>
      {installed === null ? <text fg="yellow">Détection de l'installation en cours…</text> : null}
    </box>
  );
}
