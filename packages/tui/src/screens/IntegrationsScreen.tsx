/**
 * Integrations screen: for each of the five MCP clients, the registration
 * status of the "caesar" server and the action that installs it.
 *
 * Reuses `checkMcpStatus`/`buildPlan`/`applyPlan`/`MCP_CLIENTS` from
 * `@caesar/core` — the same logic as `caesar mcp install`, never rewritten
 * here. Called directly from `@caesar/core` and not via `packages/cli`:
 * this module needs neither its `Io` shape nor its exit codes, and
 * depending on it would create a cycle with the `cli → tui` direction that
 * `caesar config` needs.
 *
 * `claude` and `codex` have no reliable, side-effect-free status read
 * (`claude mcp list` does a network health-check and has no `--json`):
 * their status honestly stays "not verifiable" rather than guessed.
 *
 * New in the rewrite: the bottom panel shows **what the action will do** —
 * the command executed or the file merged — before Enter is pressed. It is
 * the only TUI action that writes outside the project, at the client's;
 * it must not be a surprise.
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
  if (status.registered === "registered") return "registered";
  if (status.registered === "not-registered") return "not registered";
  return "not verifiable";
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
    // A single load when the screen mounts, not on every keystroke.
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
          notify(`"${client}": installation done.`);
          await refresh();
        })
        .catch((error: unknown) => {
          notify(`"${client}": installation failed — ${error instanceof Error ? error.message : String(error)}.`, true);
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
    { header: "status", min: 16, cell: (c) => (installing === c ? "installing…" : statusLabel(statuses?.get(c))), fg: (c) => statusColor(statuses?.get(c)) },
    { header: "detail", flex: 1, max: 90, cell: (c) => statuses?.get(c)?.detail ?? "", fg: () => DIM },
  ];

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title="MCP clients" focused note={`Registration of the "caesar" server for the project ${root}.`}>
        <Table
          columns={columns}
          rows={MCP_CLIENTS}
          keyOf={(c) => c}
          selectedIndex={selected}
          width={panelWidth}
        />
      </Panel>

      <Panel title={client}>
        <Field label="Status" width={panelWidth} labelWidth={LABEL_WIDTH} value={statusLabel(status)} valueFg={statusColor(status)} />
        {status?.detail ? <Field label="Detail" width={panelWidth} labelWidth={LABEL_WIDTH} value={status.detail} valueFg={DIM} /> : null}
        {plan.kind === "command" ? (
          <Field label="Will run" width={panelWidth} labelWidth={LABEL_WIDTH} value={`${plan.bin} ${plan.args.join(" ")}`} />
        ) : (
          <>
            <Field label="Will merge" width={panelWidth} labelWidth={LABEL_WIDTH} value={plan.path} />
            <Field label="Under key" width={panelWidth} labelWidth={LABEL_WIDTH} value={plan.mergeKey} />
            <Field
              label="Preserves"
              width={panelWidth}
              labelWidth={LABEL_WIDTH}
              value='the rest of the file — only the "caesar" entry is added or replaced.'
              valueFg={DIM}
            />
          </>
        )}
      </Panel>

      <box marginTop="auto" paddingTop={1}>
        <KeyHints
          hints={[
            { key: "↑↓", label: "client" },
            { key: "Enter", label: "install / update" },
          ]}
        />
      </box>
    </box>
  );
}
