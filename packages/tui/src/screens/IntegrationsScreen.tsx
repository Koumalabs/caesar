/**
 * Écran Intégrations : pour chacun des cinq clients MCP (`claude`, `codex`,
 * `copilot`, `opencode`, `antigravity`), l'état d'enregistrement du serveur
 * MCP "orch" et une action pour l'installer.
 *
 * Réutilise `checkMcpStatus`/`runMcpInstall`/`MCP_CLIENTS` de `@orch/cli`
 * (`commands/mcp.ts`) — la même logique que `orch mcp install`, jamais
 * réécrite ici (voir le brief). `claude` et `codex` n'ont pas de lecture de
 * statut fiable et sans effet de bord (`claude mcp list` fait un
 * health-check réseau et n'a pas de `--json` ; voir `checkMcpStatus`) : leur
 * statut reste honnêtement "non vérifiable" plutôt que deviné.
 *
 * `Entrée` installe/mets à jour l'enregistrement du client sélectionné —
 * l'action explicite qui déclenche l'écriture, jamais un chargement d'écran.
 */
import { useEffect, useState } from "react";
import { Writable } from "node:stream";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { checkMcpStatus, MCP_CLIENTS, runMcpInstall, type McpClient, type McpStatus } from "@orch/cli";

export interface IntegrationsScreenProps {
  root: string;
  notify: (message: string, isError?: boolean) => void;
}

/** `Io` minimal qui ne fait qu'accumuler stderr en mémoire — `runMcpInstall` en a besoin, cet écran n'affiche que le résultat. */
function makeCaptureIo(): { io: { stdout: Writable; stderr: Writable }; getErr: () => string } {
  let err = "";
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      err += chunk.toString();
      callback();
    },
  });
  return { io: { stdout, stderr }, getErr: () => err };
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
      const { io, getErr } = makeCaptureIo();
      void runMcpInstall(root, client, {}, io)
        .then(async (code) => {
          if (code === 0) notify(`"${client}" : installation effectuée.`);
          else notify(`"${client}" : échec de l'installation${getErr().trim() ? " — " + getErr().trim() : ""}.`, true);
          await refresh();
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
