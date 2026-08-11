/**
 * `orch doctor` : diagnostic d'installation. Une ligne par agent du
 * catalogue — présence, version, capacités, statut vis-à-vis de la politique —
 * suivie de ce qui manque et de comment y remédier.
 *
 * Le tableau est compact par défaut : l'énumération des capacités en toutes
 * lettres, additionnée du chemin du binaire, dépassait la largeur d'un
 * terminal et s'y repliait sur la ligne suivante, rendant illisible la vue
 * d'ensemble que cette commande existe pour donner. `--verbose` rétablit le
 * détail pour qui le cherche.
 */
import {
  describeAgentCapabilities,
  describeAgentCapabilitiesShort,
  describeAgentPolicy,
  detectAgentInstallation,
  listAgentDefinitions,
  loadConfig,
  policyFieldProvenance,
  remedyFor,
} from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, printJson, renderTable, terminalWidth, wrapText, writeLine } from "../output.js";

export interface DoctorOptions {
  json?: boolean;
  verbose?: boolean;
}

export async function runDoctor(root: string, options: DoctorOptions, io: Io): Promise<number> {
  const { config, layers } = await loadConfig(root);
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
        // Seulement pour la mise en forme compacte : `capabilities` reste ce
        // que `--json` publie, inchangé.
        capabilitiesShort: describeAgentCapabilitiesShort(def),
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

  const version = (r: (typeof rows)[number]): string => r.version ?? (r.installed ? "version inconnue" : "-");
  const tableRows = options.verbose
    ? rows.map((r) => [
        r.id,
        r.installed ? (r.path ?? "trouvé") : "absent",
        version(r),
        r.capabilities.join(", ") || "-",
        r.policy.allowed ? "autorisé" : "refusé",
      ])
    : rows.map((r) => [
        r.id,
        r.installed ? version(r) : "absent",
        r.capabilitiesShort.join(" ") || "-",
        r.policy.allowed ? "autorisé" : "refusé",
      ]);
  const headers = options.verbose
    ? ["agent", "binaire", "version", "capacités", "politique"]
    : ["agent", "version", "capacités", "politique"];
  writeLine(io.stdout, renderTable(headers, tableRows));
  writeLine(io.stdout);

  if (missing.length === 0 && denied.length === 0) {
    writeLine(io.stdout, "Tous les agents du catalogue sont installés et autorisés par la politique.");
    if (!options.verbose) writeLine(io.stdout, 'Chemins et capacités en toutes lettres : "orch doctor --verbose".');
    return EXIT_OK;
  }

  // Deux rubriques, et non plus un « À corriger » unique : un binaire absent
  // appelle une action, un agent refusé n'en appelle aucune. Les confondre
  // conduisait cette commande à proposer de lever un refus délibéré — celui
  // de `claude` par `allow_recursion`, qui est le réglage par défaut, ou
  // celui qu'on venait soi-même de poser.
  // Une puce dont la suite revient en colonne zéro se confond avec l'élément
  // suivant : on replie sur les mots, et on indente les lignes de continuation.
  const bullet = (text: string): void => {
    for (const line of wrapText(text, terminalWidth(io.stdout), "  - ", "    ")) writeLine(io.stdout, line);
  };

  if (missing.length > 0) {
    writeLine(io.stdout, "À installer :");
    for (const r of missing) {
      // Un agent déclaré en configuration porte souvent un chemin explicite
      // plutôt qu'un nom : le PATH n'entre alors pas en jeu (voir
      // `findBinaryInPath`), et parler de lui enverrait chercher au mauvais
      // endroit. Le conseil change avec la cause : on installe un binaire
      // absent du PATH, on corrige un chemin qui ne désigne rien.
      const explicitPath = r.bin.includes("/");
      bullet(
        explicitPath
          ? `"${r.id}" (${r.display_name}) : "${r.bin}" n'existe pas ou n'est pas exécutable. Corrigez le chemin ("orch agents add ${r.id} --bin <chemin>"), puis relancez "orch doctor".`
          : `"${r.id}" (${r.display_name}) : binaire "${r.bin}" introuvable dans le PATH. Installez-le, puis relancez "orch doctor".`,
      );
    }
    if (denied.length > 0) writeLine(io.stdout);
  }

  if (denied.length > 0) {
    writeLine(io.stdout, "Refusés par la politique — état voulu, sauf si vous en décidez autrement :");
    for (const r of denied) {
      // `denied` est filtré sur `!r.policy.allowed` ci-dessus ; ce garde ne
      // change rien à l'exécution, il resserre le type de `r.policy` pour que
      // `.reason`/`.rule` soient accessibles ci-dessous sans cast.
      if (r.policy.allowed) continue;
      // CONTRÔLEUR-1 de la revue finale : le remède dépend de la règle qui a
      // refusé — ni "orch agents enable" ni "orch policy allow" ne lèvent un
      // refus par récursion (`allow_recursion`), et seul le premier lève un
      // refus par "denied" (voir `remedyFor`, `@orch/core`).
      //
      // La couche qui déclare la règle compte autant que la règle : une
      // commande sans `--global` écrit dans la couche projet et laisse donc
      // intact un refus venu du global, sans que rien ne le signale.
      const scope = policyFieldProvenance(layers, r.policy.rule === "denied" ? "denied" : "allowed");
      bullet(`"${r.id}" : ${r.policy.reason} ${remedyFor(r.id, r.policy.rule, scope)}`);
    }
  }
  return EXIT_OK;
}
