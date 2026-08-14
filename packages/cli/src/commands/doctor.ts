/**
 * `caesar doctor` : diagnostic d'installation. Une ligne par agent du
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
} from "@caesar/core";
import type { Cell, Io } from "../output.js";
import {
  EXIT_OK,
  homePath,
  printDone,
  printHeading,
  printJson,
  printNote,
  printTable,
  sectionHeader,
  terminalWidth,
  wrapText,
  writeLine,
} from "../output.js";

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

  sectionHeader(io, "doctor");

  const version = (r: (typeof rows)[number]): string => r.version ?? (r.installed ? "version inconnue" : "-");
  // La politique se lit à la couleur avant de se lire au mot : c'est la seule
  // colonne de ce tableau dont on cherche la valeur plutôt que le contenu.
  const policyCell = (r: (typeof rows)[number]): Cell =>
    r.policy.allowed ? { text: "autorisé", token: "ok" } : { text: "refusé", token: "bad" };
  const tableRows: Cell[][] = options.verbose
    ? rows.map((r) => [
        r.id,
        r.installed ? homePath(r.path ?? "trouvé") : { text: "absent", token: "bad" },
        version(r),
        r.capabilities.join(", ") || "-",
        policyCell(r),
      ])
    : rows.map((r) => [
        r.id,
        r.installed ? version(r) : { text: "absent", token: "bad" },
        { text: r.capabilitiesShort.join(" ") || "-", token: "dim" },
        policyCell(r),
      ]);
  const headers = options.verbose
    ? ["agent", "binaire", "version", "capacités", "politique"]
    : ["agent", "version", "capacités", "politique"];
  printTable(io, headers, tableRows);
  writeLine(io.stdout);

  if (missing.length === 0 && denied.length === 0) {
    printDone(io, "Tous les agents du catalogue sont installés et autorisés par la politique.");
    if (!options.verbose) printNote(io, 'Chemins et capacités en toutes lettres : "caesar doctor --verbose".');
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
    printHeading(io, "à installer");
    for (const r of missing) {
      // Un agent déclaré en configuration porte souvent un chemin explicite
      // plutôt qu'un nom : le PATH n'entre alors pas en jeu (voir
      // `findBinaryInPath`), et parler de lui enverrait chercher au mauvais
      // endroit. Le conseil change avec la cause : on installe un binaire
      // absent du PATH, on corrige un chemin qui ne désigne rien.
      const explicitPath = r.bin.includes("/");
      bullet(
        explicitPath
          ? `"${r.id}" (${r.display_name}) : "${r.bin}" n'existe pas ou n'est pas exécutable. Corrigez le chemin ("caesar agents add ${r.id} --bin <chemin>"), puis relancez "caesar doctor".`
          : `"${r.id}" (${r.display_name}) : binaire "${r.bin}" introuvable dans le PATH. Installez-le, puis relancez "caesar doctor".`,
      );
    }
    if (denied.length > 0) writeLine(io.stdout);
  }

  if (denied.length > 0) {
    printHeading(io, "refusés par la politique");
    printNote(io, "État voulu, sauf si vous en décidez autrement.");
    for (const r of denied) {
      // `denied` est filtré sur `!r.policy.allowed` ci-dessus ; ce garde ne
      // change rien à l'exécution, il resserre le type de `r.policy` pour que
      // `.reason`/`.rule` soient accessibles ci-dessous sans cast.
      if (r.policy.allowed) continue;
      // CONTRÔLEUR-1 de la revue finale : le remède dépend de la règle qui a
      // refusé — ni "caesar agents enable" ni "caesar policy allow" ne lèvent un
      // refus par récursion (`allow_recursion`), et seul le premier lève un
      // refus par "denied" (voir `remedyFor`, `@caesar/core`).
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
