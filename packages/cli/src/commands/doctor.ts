/**
 * `orch doctor` : diagnostic d'installation. Une ligne par agent du
 * catalogue — présence, chemin, version, capacités notables, statut vis-à-vis
 * de la politique — suivie de ce qui manque et de comment y remédier.
 */
import { describeAgentCapabilities, describeAgentPolicy, detectAgentInstallation, listAgentDefinitions, loadConfig } from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, printJson, renderTable, writeLine } from "../output.js";

export interface DoctorOptions {
  json?: boolean;
}

export async function runDoctor(root: string, options: DoctorOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  const defs = listAgentDefinitions();

  const rows = await Promise.all(
    defs.map(async (def) => {
      const status = await detectAgentInstallation(def);
      return {
        id: def.id,
        display_name: def.displayName,
        bin: def.bin,
        installed: status.installed,
        path: status.path,
        version: status.version,
        capabilities: describeAgentCapabilities(def),
        policy: describeAgentPolicy(config.policy, def.id),
      };
    }),
  );

  const missing = rows.filter((r) => !r.installed);
  const denied = rows.filter((r) => r.installed && !r.policy.allowed);

  if (options.json) {
    printJson(io, {
      agents: rows,
      missing: missing.map((r) => r.id),
      denied: denied.map((r) => r.id),
    });
    return EXIT_OK;
  }

  const tableRows = rows.map((r) => [
    r.id,
    r.installed ? (r.path ?? "trouvé") : "absent",
    r.version ?? (r.installed ? "version inconnue" : "-"),
    r.capabilities.join(", ") || "-",
    r.policy.allowed ? "autorisé" : `refusé (${r.policy.reason})`,
  ]);
  writeLine(io.stdout, renderTable(["agent", "binaire", "version", "capacités", "politique"], tableRows));
  writeLine(io.stdout);

  if (missing.length === 0 && denied.length === 0) {
    writeLine(io.stdout, "Tous les agents du catalogue sont installés et autorisés par la politique.");
    return EXIT_OK;
  }

  writeLine(io.stdout, "À corriger :");
  for (const r of missing) {
    writeLine(io.stdout, `  - "${r.id}" (${r.display_name}) : binaire "${r.bin}" introuvable dans le PATH. Installez-le, puis relancez "orch doctor".`);
  }
  for (const r of denied) {
    const reason = r.policy.allowed ? "" : r.policy.reason;
    writeLine(io.stdout, `  - "${r.id}" : ${reason} Autorisez-le avec "orch agents enable ${r.id}" ou "orch policy allow ${r.id}".`);
  }
  return EXIT_OK;
}
