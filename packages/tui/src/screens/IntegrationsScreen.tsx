/**
 * Écran Intégrations : pour chacun des cinq clients MCP (`claude`, `codex`,
 * `copilot`, `opencode`, `antigravity`), l'état d'enregistrement du serveur
 * MCP "orch" et une action pour l'installer.
 *
 * Réutilise `checkMcpStatus`/`buildPlan`/`applyPlan`/`MCP_CLIENTS` de
 * `@orch/core` (`mcp-registration.ts`) — la même logique que `orch mcp
 * install` (`packages/cli/src/commands/mcp.ts`), jamais réécrite ici (voir
 * le brief). Appelés directement depuis `@orch/core`, pas via
 * `packages/cli` : ce module n'a besoin ni de sa forme `Io` ni de ses codes
 * de sortie, seulement du résultat — voir le rapport de correction de la
 * tâche 8 (dépendre de `packages/cli` pour ces quatre éléments créait une
 * dépendance de workspace cyclique avec le sens `cli → tui` qu'`orch config`
 * a légitimement besoin).
 *
 * `claude` et `codex` n'ont pas de lecture de statut fiable et sans effet de
 * bord (`claude mcp list` fait un health-check réseau et n'a pas de
 * `--json` ; voir `checkMcpStatus`) : leur statut reste honnêtement "non
 * vérifiable" plutôt que deviné.
 *
 * `Entrée` installe/met à jour l'enregistrement du client sélectionné —
 * l'action explicite qui déclenche l'écriture, jamais un chargement d'écran.
 */
import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { applyPlan, buildPlan, checkMcpStatus, MCP_CLIENTS, type McpClient, type McpStatus } from "@orch/core";

export interface IntegrationsScreenProps {
  root: string;
  notify: (message: string, isError?: boolean) => void;
}

export function IntegrationsScreen({ root, notify }: IntegrationsScreenProps) {
  const [statuses, setStatuses] = useState<Map<McpClient, McpStatus> | null>(null);
  const [selected, setSelected] = useState(0);
  const [installing, setInstalling] = useState<McpClient | null>(null);

  async function refresh(): Promise<void> {
    const entries = await Promise.all(
      MCP_CLIENTS.map(async (client): Promise<[McpClient, McpStatus]> => [client, await checkMcpStatus(client, root)]),
    );
    setStatuses(new Map(entries));
  }

  useEffect(() => {
    void refresh();
    // Un seul chargement au montage de l'écran, pas à chaque frappe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useKeyboard((key) => {
    if (installing) return;
    if (key.name === "up") setSelected((i) => Math.max(0, i - 1));
    else if (key.name === "down") setSelected((i) => Math.min(MCP_CLIENTS.length - 1, i + 1));
    else if (key.name === "return") {
      const client = MCP_CLIENTS[selected]!;
      setInstalling(client);
      void applyPlan(buildPlan(client, root))
        .then(async () => {
          notify(`"${client}" : installation effectuée.`);
          await refresh();
        })
        .catch((error: unknown) => {
          notify(`"${client}" : échec de l'installation — ${error instanceof Error ? error.message : String(error)}.`, true);
        })
        .finally(() => setInstalling(null));
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg="gray">Enregistrement du serveur MCP "orch" auprès de chaque client. Entrée : installer / mettre à jour.</text>
      <box flexDirection="row" marginTop={1}>
        <text attributes={TextAttributes.BOLD}>{"client".padEnd(16)}</text>
        <text attributes={TextAttributes.BOLD}>{"statut".padEnd(20)}</text>
        <text attributes={TextAttributes.BOLD}>détail</text>
      </box>
      <box flexDirection="column">
        {MCP_CLIENTS.map((client, index) => {
          const status = statuses?.get(client);
          const isSelected = index === selected;
          const label =
            status === undefined
              ? "…"
              : status.registered === "registered"
                ? "enregistré"
                : status.registered === "not-registered"
                  ? "non enregistré"
                  : "non vérifiable";
          const color = status === undefined ? "gray" : status.registered === "registered" ? "green" : status.registered === "not-registered" ? "yellow" : "gray";
          const detail = installing === client ? "installation en cours…" : (status?.detail ?? "");

          return (
            <box key={client} flexDirection="row" backgroundColor={isSelected ? "#333366" : undefined}>
              <text>{(isSelected ? "› " : "  ") + client.padEnd(14)}</text>
              <text fg={color}>{label.padEnd(20)}</text>
              <text fg="gray">{detail}</text>
            </box>
          );
        })}
      </box>
    </box>
  );
}
