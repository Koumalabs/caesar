import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";
import { EXIT_OK } from "./output.js";
import { makeIo, type CapturedIo } from "../test/support.js";

/** L'aide telle que commander l'écrit sur le flux configuré. */
function helpFor(args: readonly string[]): string {
  const io: CapturedIo = makeIo();
  const program = buildProgram(io, { value: EXIT_OK });
  const cible = args.reduce<ReturnType<typeof buildProgram> | undefined>(
    (cmd, name) => cmd?.commands.find((c) => c.name() === name),
    program,
  );
  if (!cible) throw new Error(`Commande introuvable : ${args.join(" ")}`);
  cible.outputHelp();
  return io.stdoutText();
}

describe("caesar --help", () => {
  const aide = (): string => helpFor([]);

  it("ouvre sur le logotype", () => {
    expect(aide()).toMatch(/^ ██████╗ █████╗ ███████╗███████╗ █████╗ ██████╗ \n/);
  });

  it("dit ce qu'est l'outil et quels agents il pilote", () => {
    // L'accroche du logotype ne porte que la version : c'est la description du
    // programme qui nomme les agents, et rien de plus court ne le dirait.
    expect(aide()).toMatch(/Orchestrateur de sous-agents de code/);
    expect(aide()).toMatch(/Antigravity, Codex, OpenCode, Copilot,\s+Claude/);
  });

  it("ne laisse aucun libellé anglais de commander", () => {
    const out = aide();
    for (const anglais of ["Usage:", "Options:", "Commands:", "output the version number", "display help for command"]) {
      expect(out).not.toContain(anglais);
    }
  });

  it("groupe les commandes par usage, pas par ordre de déclaration", () => {
    const out = aide();
    const rang = (titre: string): number => out.indexOf(titre);
    expect(rang("DÉMARRER")).toBeGreaterThan(-1);
    expect(rang("DÉMARRER")).toBeLessThan(rang("DÉLÉGUER"));
    expect(rang("DÉLÉGUER")).toBeLessThan(rang("SUIVRE"));
    expect(rang("SUIVRE")).toBeLessThan(rang("CONFIGURER"));
    expect(rang("CONFIGURER")).toBeLessThan(rang("INTÉGRER"));
    // `run` est déclarée après `agents` dans `program.ts` : sans le
    // regroupement, elle apparaîtrait plus bas.
    expect(out.indexOf("\n  run ")).toBeLessThan(out.indexOf("\n  agents "));
  });

  it("n'oublie aucune commande visible", () => {
    const io: CapturedIo = makeIo();
    const program = buildProgram(io, { value: EXIT_OK });
    const out = aide();
    for (const sub of program.commands) {
      // `channel` est masquée (atteinte par auto-invocation, jamais tapée).
      if (sub.name() === "channel") continue;
      expect(out, `commande absente de l'aide : ${sub.name()}`).toMatch(new RegExp(`\\n  ${sub.name()}\\s`));
    }
  });

  it("nomme --root et --json, que chaque commande accepte", () => {
    // Elles sont posées commande par commande, donc absentes des options du
    // programme : sans cet ajout explicite, l'aide racine ne les citait pas.
    expect(aide()).toMatch(/--root <dir>\s+Racine du projet/);
    expect(aide()).toMatch(/--json\s+Sortie machine/);
  });

  it("ne porte aucune séquence ANSI hors terminal", () => {
    expect(aide()).not.toMatch(/\x1b\[/);
  });

  it("replie les descriptions plutôt que de les laisser déborder", () => {
    for (const ligne of aide().split("\n")) expect(ligne.length).toBeLessThanOrEqual(80);
  });
});

describe("caesar <commande> --help", () => {
  it("emploie la même présentation que l'aide racine", () => {
    // La configuration d'aide est posée avant la création des sous-commandes :
    // réglée après, elle n'aurait touché que la racine et aurait laissé
    // celle-ci en anglais.
    const out = helpFor(["run"]);
    expect(out).toContain("ARGUMENTS");
    expect(out).toContain("OPTIONS");
    expect(out).not.toContain("Usage:");
    expect(out).not.toContain("display help for command");
  });

  it("ouvre sur la ligne d'usage, sans logotype", () => {
    const out = helpFor(["run"]);
    expect(out).toMatch(/^caesar run \[options\] <objective> \[extra_args\.\.\.\]\n/);
    expect(out).not.toContain("▄▀▀▀▄");
  });

  it("liste les sous-commandes d'un groupe avec leur forme complète", () => {
    const out = helpFor(["agents"]);
    expect(out).toContain("COMMANDES");
    expect(out).toMatch(/enable \[options\] <id>/);
  });

  it("sépare toujours un terme trop long de sa description", () => {
    // `add [options] <id>` tient ; un terme au delà de la colonne prend sa
    // propre ligne — sans quoi la description se collait à lui.
    for (const ligne of helpFor(["agents"]).split("\n")) {
      expect(ligne).not.toMatch(/\]\S/);
      expect(ligne).not.toMatch(/>\S/);
    }
  });
});
