/**
 * L'aide de `orch`, mise en forme.
 *
 * C'est la porte d'entrée, et c'était la surface la moins soignée : commander
 * rendait sa présentation par défaut, avec ses libellés anglais au milieu du
 * français (« Usage: », « Options: », « output the version number »), les
 * commandes dans leur ordre de déclaration, et les descriptions débordant la
 * largeur du terminal sans se replier.
 *
 * Deux partis pris tiennent cette version :
 *
 *  - **Les commandes sont groupées par usage, pas par ordre de déclaration.**
 *    Seize commandes en liste plate n'apprennent rien à qui découvre l'outil ;
 *    cinq groupes de trois disent l'ordre dans lequel on s'en sert.
 *  - **La description est repliée avec un retrait pendant.** Sans lui, la
 *    suite d'une description revient en colonne zéro et se confond avec la
 *    commande suivante.
 */
import type { Command, Help } from "commander";
import type { Io } from "./output.js";
import { bannerLines, colorize, terminalWidth, wrapText } from "./output.js";
import { VERSION } from "./version.js";

/**
 * L'ordre dans lequel on rencontre les commandes, et non celui dans lequel
 * elles ont été écrites.
 *
 * Une commande absente de cette table n'est pas perdue : elle atterrit dans
 * un groupe « autres ». Oublier d'y inscrire une commande neuve doit se voir,
 * jamais la faire disparaître de l'aide.
 */
const GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  { title: "démarrer", commands: ["init", "doctor", "config"] },
  { title: "déléguer", commands: ["run", "watch"] },
  { title: "suivre", commands: ["ps", "logs", "cancel", "diff", "apply", "gc"] },
  { title: "configurer", commands: ["agents", "policy", "role"] },
  { title: "intégrer", commands: ["mcp", "protocol"] },
];

/** Largeur de la colonne de gauche. Au delà, le terme prend sa ligne et la description suit. */
const TERM_WIDTH = 24;
const INDENT = "  ";

/**
 * Une entrée « terme + description ». Le terme est coloré **après** le calage,
 * sinon les séquences ANSI compteraient comme des colonnes.
 *
 * Un terme plus long que la colonne prend sa propre ligne, et la description
 * s'écrit dessous : le coller à son terme donnait
 * `[extra_args...]Délègue un objectif…`, sans même un espace.
 */
function entry(term: string, description: string, width: number, io: Io, token: "accent" | "strong" = "accent"): string[] {
  const peint = INDENT + colorize(term.padEnd(TERM_WIDTH), token, io.stdout);
  if (description === "") return [(INDENT + term).trimEnd()];

  const retrait = " ".repeat(INDENT.length + TERM_WIDTH);
  const lignes = wrapText(description, Math.max(20, width - retrait.length)).map((l) => colorize(l, "dim", io.stdout));
  if (term.length >= TERM_WIDTH) {
    return [INDENT + colorize(term, token, io.stdout), ...lignes.map((l) => retrait + l)];
  }
  return lignes.map((ligne, i) => (i === 0 ? peint + ligne : retrait + ligne));
}

function title(text: string, io: Io): string {
  return colorize(text.toUpperCase(), "faint", io.stdout);
}

/**
 * La mise en forme de l'aide, pour la commande racine comme pour chaque
 * sous-commande — une seule présentation, sinon `orch --help` et
 * `orch run --help` se répondraient dans deux langues.
 */
export function formatHelp(cmd: Command, helper: Help, io: Io): string {
  const width = terminalWidth(io.stdout);
  const lines: string[] = [];
  const racine = cmd.parent === null || cmd.parent === undefined;

  if (racine) {
    // Le logotype porte la version ; la description du programme suit, en
    // toutes lettres — c'est elle qui nomme les agents pris en charge, et
    // aucune accroche plus courte ne le dirait.
    lines.push(...bannerLines(io.stdout, `v${VERSION}`), "");
    const description = helper.commandDescription(cmd);
    if (description) lines.push(...wrapText(description, width, INDENT).map((l) => colorize(l, "dim", io.stdout)), "");
  } else {
    lines.push(colorize(helper.commandUsage(cmd), "title", io.stdout), "");
    const description = helper.commandDescription(cmd);
    if (description) lines.push(...wrapText(description, width, INDENT).map((l) => colorize(l, "dim", io.stdout)), "");
  }

  if (racine) {
    lines.push(title("usage", io));
    lines.push(...entry("orch <commande> [options]", "", width, io, "strong"));
    lines.push("");
  }

  const arguments_ = helper.visibleArguments(cmd);
  if (arguments_.length > 0) {
    lines.push(title("arguments", io));
    for (const arg of arguments_) {
      lines.push(...entry(helper.argumentTerm(arg), helper.argumentDescription(arg), width, io, "strong"));
    }
    lines.push("");
  }

  const commands = helper.visibleCommands(cmd);
  if (commands.length > 0) {
    const restantes = new Map(commands.map((sub) => [sub.name(), sub]));
    // À la racine, le nom seul : `[options]` figure sur chacune des seize
    // commandes, donc n'en distingue aucune, et les arguments sont détaillés
    // par `orch <commande> --help`. Dans un sous-groupe (`orch agents
    // --help`), le terme complet reprend sa place — il y a alors trois
    // entrées, et leur forme est ce qu'on vient lire.
    const terme = (sub: Command): string => (racine ? sub.name() : helper.subcommandTerm(sub));
    const rendre = (titre: string, sous: readonly Command[]): void => {
      if (sous.length === 0) return;
      lines.push(title(titre, io));
      for (const sub of sous) {
        lines.push(...entry(terme(sub), helper.subcommandDescription(sub), width, io));
      }
      lines.push("");
    };

    if (racine) {
      for (const groupe of GROUPS) {
        const sous = groupe.commands.map((name) => restantes.get(name)).filter((c): c is Command => c !== undefined);
        for (const sub of sous) restantes.delete(sub.name());
        rendre(groupe.title, sous);
      }
      // Ce qui n'a pas été classé — une commande neuve, le plus souvent.
      rendre("autres", [...restantes.values()].filter((sub) => sub.name() !== "help"));
      const aide = restantes.get("help");
      if (aide) rendre("aide", [aide]);
    } else {
      rendre("commandes", commands);
    }
  }

  const options = helper.visibleOptions(cmd);
  if (options.length > 0) {
    lines.push(title("options", io));
    for (const option of options) {
      lines.push(...entry(helper.optionTerm(option), helper.optionDescription(option), width, io, "strong"));
    }
    if (racine) {
      // `--root` et `--json` sont posées commande par commande
      // (`withCommonOptions`), donc absentes des options du programme : les
      // ranger sous un titre « options communes » aurait laissé croire
      // qu'elles figuraient dans la liste ci-dessus.
      lines.push(...entry("--root <dir>", "Racine du projet. Acceptée par toutes les commandes.", width, io, "strong"));
      lines.push(...entry("--json", "Sortie machine, sans couleur ni mise en forme. Acceptée par toutes les commandes.", width, io, "strong"));
    }
    lines.push("");
  }

  if (racine) {
    lines.push(colorize('  "orch <commande> --help" pour le détail d\'une commande.', "dim", io.stdout));
    lines.push("");
  }

  // Une seule ligne vide finale, quel que soit le nombre de sections rendues.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}
