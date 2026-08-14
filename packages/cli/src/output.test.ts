import { afterEach, describe, expect, it } from "vitest";
import { colorize, homePath, printJson, printError, printTable, printWarning, sectionHeader, writeLine } from "./output.js";
import { makeIo, type CapturedIo } from "../test/support.js";

/** Un flux capturé qui se présente comme un terminal, pour éprouver la couleur. */
function ttyIo(columns?: number): CapturedIo {
  const io = makeIo();
  const stdout = io.stdout as unknown as { isTTY?: boolean; columns?: number };
  stdout.isTTY = true;
  if (columns !== undefined) stdout.columns = columns;
  return io;
}

/** Longueur affichée : les séquences ANSI n'occupent aucune colonne. */
function visibleLength(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["NO_COLOR", "COLORTERM", "TERM", "LC_ALL", "LC_CTYPE", "LANG"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("output", () => {
  it("printJson n'écrit que le JSON, sans couleur, terminé par un saut de ligne", () => {
    const io: CapturedIo = makeIo();
    printJson(io, { a: 1, b: [1, 2] });
    expect(io.stdoutText()).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("printError écrit sur stderr, jamais sur stdout", () => {
    const io: CapturedIo = makeIo();
    printError(io, "quelque chose a mal tourné");
    expect(io.stderrText()).toBe("quelque chose a mal tourné\n");
    expect(io.stdoutText()).toBe("");
  });

  it("printWarning écrit sur stderr", () => {
    const io: CapturedIo = makeIo();
    printWarning(io, "attention");
    expect(io.stderrText()).toBe("attention\n");
  });

  it("colorize ne colore jamais un flux sans isTTY (cas des tests, et de tout pipe)", () => {
    const io: CapturedIo = makeIo();
    expect(colorize("texte", "bad", io.stdout)).toBe("texte");
  });

  it("colorize respecte NO_COLOR même sur un flux isTTY", () => {
    const io = ttyIo();
    process.env["NO_COLOR"] = "1";
    expect(colorize("texte", "bad", io.stdout)).toBe("texte");
  });

  it("colorize rend le jeton du thème, pas une couleur nommée", () => {
    const io = ttyIo();
    delete process.env["NO_COLOR"];
    process.env["COLORTERM"] = "truecolor";
    // #E88388, la teinte BAD de la palette — et non le rouge ANSI de base.
    expect(colorize("texte", "bad", io.stdout)).toBe("\x1b[38;2;232;131;136mtexte\x1b[0m");
  });

  it("chaque flux décide pour lui-même : stdout redirigé, stderr au terminal", () => {
    const io: CapturedIo = makeIo();
    (io.stderr as unknown as { isTTY?: boolean }).isTTY = true;
    delete process.env["NO_COLOR"];
    process.env["COLORTERM"] = "truecolor";
    expect(colorize("texte", "bad", io.stdout)).toBe("texte");
    expect(colorize("texte", "bad", io.stderr)).toMatch(/\x1b\[38;2;/);
  });

  it("writeLine ajoute un saut de ligne", () => {
    const io: CapturedIo = makeIo();
    writeLine(io.stdout, "bonjour");
    expect(io.stdoutText()).toBe("bonjour\n");
  });
});

describe("homePath", () => {
  it("remplace le répertoire personnel par ~", () => {
    const home = process.env["HOME"] ?? "";
    expect(homePath(`${home}/.local/bin/codex`)).toBe("~/.local/bin/codex");
  });

  it("laisse intact un chemin qui n'en vient pas", () => {
    expect(homePath("/usr/local/bin/codex")).toBe("/usr/local/bin/codex");
  });

  it("ne rogne pas un répertoire qui commence par le même nom", () => {
    const home = process.env["HOME"] ?? "";
    expect(homePath(`${home}-autre/bin`)).toBe(`${home}-autre/bin`);
  });
});

describe("sectionHeader", () => {
  it("nomme la commande et tient exactement la largeur du terminal", () => {
    const io = ttyIo(80);
    sectionHeader(io, "doctor");
    const [rule, blank] = io.stdoutText().split("\n");
    expect((rule ?? "").replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/caesar · doctor/);
    expect(visibleLength(rule ?? "")).toBe(80);
    expect(blank).toBe("");
  });

  it("ne porte aucune séquence ANSI hors terminal", () => {
    const io: CapturedIo = makeIo();
    sectionHeader(io, "ps");
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    // La structure, elle, reste : c'est ce qu'un fichier ou un test doit voir.
    expect(io.stdoutText()).toMatch(/^▞▚ caesar · ps ─+\n\n$/);
  });
});

describe("printTable", () => {
  it("encadre le tableau et aligne les colonnes", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["id", "nom"], [["1", "courte"], ["22", "plus longue"]], { maxWidth: 80 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("╭────┬─────────────╮");
    expect(lines[1]).toBe("│ id │ nom         │");
    expect(lines[2]).toBe("├────┼─────────────┤");
    expect(lines[3]).toBe("│ 1  │ courte      │");
    expect(lines[5]).toBe("╰────┴─────────────╯");
  });

  it("ne déborde jamais de la largeur donnée", () => {
    const io: CapturedIo = makeIo();
    const long = "une valeur beaucoup trop longue pour la place disponible";
    printTable(io, ["a", "b", "c"], [[long, long, long]], { maxWidth: 40 });
    for (const line of io.stdoutText().split("\n").filter(Boolean)) {
      expect(visibleLength(line)).toBeLessThanOrEqual(40);
    }
  });

  it("le cadre est compté dans le budget : les cellules perdent ce qu'il coûte", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["a", "b"], [["x".repeat(50), "y".repeat(50)]], { maxWidth: 30 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    // 2 colonnes encadrées coûtent 3×2+1 = 7 caractères de chrome.
    expect(lines[0]).toHaveLength(30);
    expect(lines[3]).toMatch(/^│ x+… │ y+… │$/);
  });

  it("renonce au cadre plutôt que de le rompre quand il ne peut pas tenir", () => {
    const io: CapturedIo = makeIo();
    const headers = ["a", "b", "c", "d", "e", "f", "g", "h"];
    printTable(io, headers, [headers.map(() => "valeur")], { maxWidth: 60 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    expect(lines.some((line) => /[╭╮╰╯│┬┴┼]/.test(line))).toBe(false);
    expect(lines[1]).toMatch(/^─+$/);
    // Huit colonnes de six caractères : 62 sans cadre, 73 avec. Le repli
    // récupère onze colonnes, et déborde encore de deux — c'est le contrat
    // hérité, assumé dans `printTable` : mieux vaut un tableau que le terminal
    // replie qu'un tableau dont chaque cellule vaut « … ».
    expect(Math.max(...lines.map(visibleLength))).toBe(62);
  });

  it("le repli reste plus étroit que le cadre auquel il renonce", () => {
    const headers = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const rows = [headers.map(() => "valeur")];
    const étroit = makeIo();
    const large = makeIo();
    printTable(étroit, headers, rows, { maxWidth: 60 });
    printTable(large, headers, rows, { maxWidth: 100 });
    const widest = (io: CapturedIo): number =>
      Math.max(...io.stdoutText().split("\n").filter(Boolean).map(visibleLength));
    expect(widest(étroit)).toBeLessThan(widest(large));
  });

  it("une cellule peut porter un rôle du thème sans que le tableau connaisse le domaine", () => {
    const io = ttyIo(80);
    delete process.env["NO_COLOR"];
    process.env["COLORTERM"] = "truecolor";
    printTable(io, ["agent", "politique"], [["codex", { text: "autorisé", token: "ok" }]]);
    const body = io.stdoutText().split("\n")[3] ?? "";
    expect(body).toMatch(/\x1b\[38;2;125;206;130mautorisé\s*\x1b\[0m/);
    // La couleur est posée après le calage : la ligne garde sa largeur.
    expect(visibleLength(body)).toBe(visibleLength(io.stdoutText().split("\n")[0] ?? ""));
  });

  it("ne porte aucune séquence ANSI hors terminal, cellules colorées comprises", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["agent", "politique"], [["codex", { text: "refusé", token: "bad" }]], { maxWidth: 80 });
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    expect(io.stdoutText()).toMatch(/refusé/);
  });

  it("retombe sur des traits ASCII quand la locale n'est pas en UTF-8", () => {
    const io: CapturedIo = makeIo();
    process.env["LC_ALL"] = "C";
    printTable(io, ["id"], [["1"]], { maxWidth: 80 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    expect(lines[0]).toBe("+----+");
    expect(lines[1]).toBe("| id |");
    // Le repli garde exactement la même largeur que le tracé Unicode.
    expect(lines[0]).toHaveLength(6);
  });

  it("marque la troncature d'une cellule rognée", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["chemin"], [["/un/chemin/vraiment/tres/long"]], { maxWidth: 20 });
    expect(io.stdoutText()).toMatch(/…/);
  });
});
