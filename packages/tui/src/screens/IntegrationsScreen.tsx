/**
 * Écran Intégrations : pour chacun des cinq clients MCP, l'état
 * d'enregistrement du serveur "caesar" et l'action qui l'installe.
 *
 * Réutilise `checkMcpStatus`/`buildPlan`/`applyPlan`/`MCP_CLIENTS` de
 * `@caesar/core` — la même logique que `caesar mcp install`, jamais réécrite ici.
 * Appelés directement depuis `@caesar/core` et non via `packages/cli` : ce
 * module n'a besoin ni de sa forme `Io` ni de ses codes de sortie, et en
 * dépendre créerait un cycle avec le sens `cli → tui` dont `caesar config` a
 * besoin.
 *
 * `claude` et `codex` n'ont pas de lecture de statut fiable et sans effet de
 * bord (`claude mcp list` fait un health-check réseau et n'a pas de
 * `--json`) : leur statut reste honnêtement « non vérifiable » plutôt que
 * deviné.
 *
 * Nouveauté de la réécriture : le panneau du bas montre **ce que l'action
 * fera** — la commande exécutée ou le fichier fusionné — avant qu'on appuie
 * sur Entrée. C'est la seule action du TUI qui écrit hors du projet, chez le
 * client ; elle ne doit pas être une surprise.
 */
import { useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { applyPlan, buildPlan, checkMcpStatus, MCP_CLIENTS, type McpClient, type McpStatus } from "@caesar/core";
import { Field } from "../ui/Field";
import { KeyHints } from "../ui/KeyHints";
import { Panel } from "../ui/Panel";
import { Table, type TableColumn } from "../ui/Table";
import { DIM, OK, WARN } from "../ui/theme";

export interface IntegrationsScreenProps {
  root: string;
  notify: (message: string, isError?: boolean) => void;
}

const LABEL_WIDTH = 12;

function statusLabel(status: McpStatus | undefined): string {
  if (status === undefined) return "…";
  if (status.registered === "registered") return "enregistré";
  if (status.registered === "not-registered") return "non enregistré";
  return "non vérifiable";
}

function statusColor(status: McpStatus | undefined): string {
  if (status === undefined) return DIM;
  if (status.registered === "registered") return OK;
  if (status.registered === "not-registered") return WARN;
  return DIM;
}

export function IntegrationsScreen({ root, notify }: IntegrationsScreenProps) {
  const { width } = useTerminalDimensions();
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
    if (key.name === "up" || key.name === "k") setSelected((i) => Math.max(0, i - 1));
    else if (key.name === "down" || key.name === "j") setSelected((i) => Math.min(MCP_CLIENTS.length - 1, i + 1));
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

  const panelWidth = Math.max(30, width - 6);
  const client = MCP_CLIENTS[selected]!;
  const status = statuses?.get(client);
  const plan = buildPlan(client, root);

  const columns: Array<TableColumn<McpClient>> = [
    { header: "client", min: 14, cell: (c) => c },
    { header: "statut", min: 16, cell: (c) => (installing === c ? "installation…" : statusLabel(statuses?.get(c))), fg: (c) => statusColor(statuses?.get(c)) },
    { header: "détail", flex: 1, max: 90, cell: (c) => statuses?.get(c)?.detail ?? "", fg: () => DIM },
  ];

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title="Clients MCP" focused note={`Enregistrement du serveur "caesar" pour le projet ${root}.`}>
        <Table
          columns={columns}
          rows={MCP_CLIENTS}
          keyOf={(c) => c}
          selectedIndex={selected}
          width={panelWidth}
        />
      </Panel>

      <Panel title={client}>
        <Field label="Statut" width={panelWidth} labelWidth={LABEL_WIDTH} value={statusLabel(status)} valueFg={statusColor(status)} />
        {status?.detail ? <Field label="Détail" width={panelWidth} labelWidth={LABEL_WIDTH} value={status.detail} valueFg={DIM} /> : null}
        {plan.kind === "command" ? (
          <Field label="Exécutera" width={panelWidth} labelWidth={LABEL_WIDTH} value={`${plan.bin} ${plan.args.join(" ")}`} />
        ) : (
          <>
            <Field label="Fusionnera" width={panelWidth} labelWidth={LABEL_WIDTH} value={plan.path} />
            <Field label="Sous la clé" width={panelWidth} labelWidth={LABEL_WIDTH} value={plan.mergeKey} />
            <Field
              label="Préserve"
              width={panelWidth}
              labelWidth={LABEL_WIDTH}
              value="le reste du fichier — seule l'entrée « caesar » est ajoutée ou remplacée."
              valueFg={DIM}
            />
          </>
        )}
      </Panel>

      <box marginTop="auto" paddingTop={1}>
        <KeyHints
          hints={[
            { key: "↑↓", label: "client" },
            { key: "Entrée", label: "installer / mettre à jour" },
          ]}
        />
      </box>
    </box>
  );
}
