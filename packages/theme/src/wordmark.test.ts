import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs.js";
import { renderSectionRule, renderWordmark, WORDMARK_LINES, WORDMARK_WIDTH } from "./wordmark.js";

/** Longueur affichée : les séquences ANSI n'occupent aucune colonne. */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

describe("logotype", () => {
  it("chaque ligne fait exactement la largeur annoncée", () => {
    // C'est l'assertion qui protège le dessin : une ligne d'un caractère de
    // trop ou de moins désaligne une lettre, et rien d'autre ne le dirait.
    for (const line of WORDMARK_LINES) expect([...line].length).toBe(WORDMARK_WIDTH);
  });

  it("n'emploie que des demi-blocs et des espaces", () => {
    expect(WORDMARK_LINES.join("")).toMatch(/^[▀▄█ ]+$/);
  });

  it("porte une couleur par ligne, du plus clair au plus sombre", () => {
    const lines = renderWordmark(UNICODE_GLYPHS, "truecolor");
    expect(lines).toHaveLength(4);
    const codes = lines.map((line) => /38;2;(\d+);(\d+);(\d+)/.exec(line)?.[0]);
    expect(new Set(codes).size).toBe(4);
    for (const line of lines) expect(visibleLength(line)).toBe(WORDMARK_WIDTH);
  });

  it("sans Unicode, rend le nom sur une ligne plutôt qu'un dessin grossier", () => {
    expect(renderWordmark(ASCII_GLYPHS, "truecolor")).toHaveLength(1);
    expect(renderWordmark(ASCII_GLYPHS, "none")).toEqual(["CAESAR"]);
  });

  it("l'accroche s'ajoute en dernière ligne", () => {
    const lines = renderWordmark(UNICODE_GLYPHS, "none", "orchestrateur de sous-agents · v0.1.0");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("  orchestrateur de sous-agents · v0.1.0");
  });

  it("sans couleur, ne laisse aucune séquence ANSI", () => {
    expect(renderWordmark(UNICODE_GLYPHS, "none").join("\n")).not.toMatch(/\x1b\[/);
  });
});

describe("bandeau de commande", () => {
  it("occupe exactement la largeur demandée", () => {
    for (const width of [40, 60, 80, 120]) {
      expect(visibleLength(renderSectionRule("doctor", width, UNICODE_GLYPHS, "truecolor"))).toBe(width);
    }
  });

  it("ne déborde jamais, même quand le libellé ne tient pas", () => {
    // Le filet disparaît plutôt que de repousser le bandeau sur deux lignes.
    const rule = renderSectionRule("une-commande-au-nom-interminable", 20, UNICODE_GLYPHS, "none");
    expect(rule).not.toMatch(/─/);
  });

  it("garde la même largeur avec le jeu ASCII", () => {
    expect(visibleLength(renderSectionRule("ps", 80, ASCII_GLYPHS, "none"))).toBe(80);
    expect(renderSectionRule("ps", 80, ASCII_GLYPHS, "none")).toMatch(/^:: caesar - ps -+$/);
  });

  it("nomme la commande", () => {
    expect(renderSectionRule("doctor", 80, UNICODE_GLYPHS, "none")).toMatch(/caesar · doctor/);
  });
});
