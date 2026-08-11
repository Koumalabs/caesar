import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, glyphsFor, supportsUnicode, UNICODE_GLYPHS } from "./glyphs.js";

describe("supportsUnicode", () => {
  it("reconnaît l'UTF-8 sous ses deux orthographes", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(supportsUnicode({ LANG: "fr_FR.utf8" })).toBe(true);
  });

  it("refuse une locale POSIX explicite", () => {
    expect(supportsUnicode({ LC_ALL: "C" })).toBe(false);
    expect(supportsUnicode({ LANG: "C" })).toBe(false);
  });

  it("respecte la précédence POSIX : LC_ALL, puis LC_CTYPE, puis LANG", () => {
    expect(supportsUnicode({ LC_ALL: "C", LC_CTYPE: "en_US.UTF-8", LANG: "en_US.UTF-8" })).toBe(false);
    expect(supportsUnicode({ LC_CTYPE: "C", LANG: "en_US.UTF-8" })).toBe(false);
    expect(supportsUnicode({ LC_ALL: "en_US.UTF-8", LANG: "C" })).toBe(true);
  });

  it("répond oui quand rien n'est déclaré", () => {
    // Le cas courant sous macOS : terminal en UTF-8, aucune variable posée.
    // Répondre non priverait la majorité du thème pour protéger une minorité
    // qui, elle, se signale toujours (LC_ALL=C).
    expect(supportsUnicode({})).toBe(true);
    expect(supportsUnicode({ LANG: "" })).toBe(true);
  });
});

describe("glyphsFor", () => {
  it("choisit le jeu selon la locale", () => {
    expect(glyphsFor({ LANG: "en_US.UTF-8" })).toBe(UNICODE_GLYPHS);
    expect(glyphsFor({ LC_ALL: "C" })).toBe(ASCII_GLYPHS);
  });

  it("les deux jeux occupent la même largeur, caractère par caractère", () => {
    // Tout le calcul de largeur de `renderTable` en dépend : un repli ASCII
    // plus large décalerait chaque bordure droite.
    const box = Object.keys(UNICODE_GLYPHS.box) as (keyof typeof UNICODE_GLYPHS.box)[];
    for (const key of box) {
      expect([...UNICODE_GLYPHS.box[key]].length).toBe([...ASCII_GLYPHS.box[key]].length);
    }
    const status = Object.keys(UNICODE_GLYPHS.status) as (keyof typeof UNICODE_GLYPHS.status)[];
    for (const key of status) {
      expect([...UNICODE_GLYPHS.status[key]].length).toBe([...ASCII_GLYPHS.status[key]].length);
    }
    expect([...UNICODE_GLYPHS.ellipsis].length).toBe([...ASCII_GLYPHS.ellipsis].length);
  });

  it("le jeu ASCII n'emploie que de l'ASCII", () => {
    const everything = [
      ...Object.values(ASCII_GLYPHS.box),
      ...Object.values(ASCII_GLYPHS.status),
      ASCII_GLYPHS.ellipsis,
    ].join("");
    // eslint-disable-next-line no-control-regex
    expect(everything).toMatch(/^[\x20-\x7e]+$/);
  });
});
