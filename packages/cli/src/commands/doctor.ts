/**
 * `orch doctor` : diagnostic d'installation. Une ligne par agent du
 * catalogue — présence, chemin, version, capacités notables, statut vis-à-vis
 * de la politique — suivie de ce qui manque et de comment y remédier.
 */
import { describeAgentCapabilities, describeAgentPolicy, detectAgentInstallation, listAgentDefinitions, loadConfig, remedyFor } from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, printJson, renderTable, writeLine } from "../output.js";

export interface DoctorOptions {
  json?: boolean;
}

export async function runDoctor(root: string, options: DoctorOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  // Catalogue natif étendu des agents de configuration ([[agent]]) : voir C1
  // de la revue finale.
  const defs = listAgentDefinitions(config.agents);

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
    // `denied` est filtré sur `!r.policy.allowed` ci-dessus ; ce garde ne
    // change rien à l'exécution, il resserre le type de `r.policy` pour que
    // `.reason`/`.rule` soient accessibles ci-dessous sans cast.
    if (r.policy.allowed) continue;
    // CONTRÔLEUR-1 de la revue finale : le remède dépend de la règle qui a
    // refusé — ni "orch agents enable" ni "orch policy allow" ne lèvent un
    // refus par récursion (`allow_recursion`), et seul le premier lève un
    // refus par "denied" (voir `remedyFor`, `@orch/core`).
    writeLine(io.stdout, `  - "${r.id}" : ${r.policy.reason} ${remedyFor(r.id, r.policy.rule)}`);
  }
  return EXIT_OK;
}
