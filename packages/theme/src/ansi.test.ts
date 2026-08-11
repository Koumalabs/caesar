import { describe, expect, it } from "vitest";
import {
  detectColorDepth,
  foreground,
  paint,
  parseHex,
  RESET,
  toAnsi16,
  toAnsi256,
} from "./ansi.js";
import { ACCENT, BAD, DIM, FAINT, OK, WARN } from "./palette.js";

describe("detectColorDepth", () => {
  it("NO_COLOR prime sur tout, y compris sur COLORTERM", () => {
    expect(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-256color" })).toBe("none");
  });

  it('TERM=dumb décrit un terminal sans séquence de contrôle', () => {
    expect(detectColorDepth({ TERM: "dumb" })).toBe("none");
  });

  it("COLORTERM annonce le truecolor, sous ses deux orthographes", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor", TERM: "xterm-ghostty" })).toBe("truecolor");
    expect(detectColorDepth({ COLORTERM: "24bit" })).toBe("truecolor");
  });

  it("un TERM en 256color sans COLORTERM donne 256 couleurs", () => {
    expect(detectColorDepth({ TERM: "screen-256color" })).toBe("ansi256");
  });

  it("sans rien d'annoncé, on reste aux 16 couleurs de base", () => {
    // Prudence délibérée : une séquence 256 émise vers un terminal qui l'ignore
    // s'affiche en clair au milieu du texte.
    expect(detectColorDepth({ TERM: "xterm" })).toBe("ansi16");
    expect(detectColorDepth({})).toBe("ansi16");
  });
});

describe("parseHex", () => {
  it("lit la forme longue, avec ou sans dièse", () => {
    expect(parseHex("#7AA2F7")).toEqual([0x7a, 0xa2, 0xf7]);
    expect(parseHex("7aa2f7")).toEqual([0x7a, 0xa2, 0xf7]);
  });

  it("développe la forme courte", () => {
    expect(parseHex("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("refuse ce que Number.parseInt accepterait en silence", () => {
    // "12345g" vaudrait 0x12345 pour parseInt : une couleur fausse, sans bruit.
    expect(() => parseHex("#12345g")).toThrow(/invalide/);
    expect(() => parseHex("#12345")).toThrow(/invalide/);
  });
});

describe("dégradation des couleurs", () => {
  it("truecolor rend la teinte exacte", () => {
    expect(foreground(ACCENT, "truecolor")).toBe("\x1b[38;2;122;162;247m");
  });

  it("256 couleurs rend un index du cube ou de la rampe de gris", () => {
    const escape = foreground(ACCENT, "ansi256");
    expect(escape).toMatch(/^\x1b\[38;5;\d{1,3}m$/);
  });

  it("un vrai gris passe par la rampe de gris, que le cube ne sait pas rendre", () => {
    // Le cube 6×6×6 n'a que six paliers par axe : #808080 y deviendrait
    // #878787. La rampe de 24 gris le rend exactement.
    expect(toAnsi256([0x80, 0x80, 0x80])).toBe(244);
  });

  it("un demi-ton qui penche garde son penchant plutôt que de virer au gris", () => {
    // DIM (#8992A6) a 29 points de bleu de plus que de rouge : le cube lui est
    // plus fidèle que le gris le plus proche, et c'est lui qui doit gagner.
    const index = toAnsi256([0x89, 0x92, 0xa6]);
    expect(index).toBeLessThan(232);
    expect(index).toBe(103);
  });

  it("le noir et le blanc purs restent dans le cube", () => {
    expect(toAnsi256([0, 0, 0])).toBe(16);
    expect(toAnsi256([255, 255, 255])).toBe(231);
  });

  it("les couleurs sémantiques gardent leur teinte à 16 couleurs", () => {
    // C'est ce que la distance euclidienne dans RGB perdait : ces quatre
    // teintes sont des demi-tons, donc toutes plus proches du gris moyen que
    // de leur primaire. « Autorisé » et « refusé » seraient devenus gris.
    expect(toAnsi16(parseHex(OK))).toBe(92); // vert vif
    expect(toAnsi16(parseHex(WARN))).toBe(93); // jaune vif
    expect(toAnsi16(parseHex(BAD))).toBe(91); // rouge vif
    expect(toAnsi16(parseHex(ACCENT))).toBe(94); // bleu vif
  });

  it("les neutres sont choisis sur leur clarté, pas sur une teinte inventée", () => {
    expect(toAnsi16(parseHex(DIM))).toBe(90);
    expect(toAnsi16(parseHex(FAINT))).toBe(90);
    expect(toAnsi16([0, 0, 0])).toBe(30);
    expect(toAnsi16([255, 255, 255])).toBe(97);
  });

  it("les primaires sombres restent sombres, les vives restent vives", () => {
    expect(toAnsi16([0xcd, 0x00, 0x00])).toBe(31);
    expect(toAnsi16([0xff, 0x00, 0x00])).toBe(91);
    expect(toAnsi16([0x00, 0xcd, 0x00])).toBe(32);
  });

  it("aucune profondeur n'émet de séquence quand la couleur est coupée", () => {
    expect(foreground(ACCENT, "none")).toBe("");
  });
});

describe("paint", () => {
  it("rend le texte strictement inchangé quand la couleur est coupée", () => {
    expect(paint("texte", { hex: ACCENT, bold: true }, "none")).toBe("texte");
  });

  it("n'émet ni séquence vide ni RESET orphelin quand aucun style ne s'applique", () => {
    expect(paint("texte", {}, "truecolor")).toBe("texte");
  });

  it("ferme toujours ce qu'il ouvre", () => {
    expect(paint("texte", { hex: ACCENT }, "truecolor")).toBe(`\x1b[38;2;122;162;247mtexte${RESET}`);
    expect(paint("texte", { bold: true }, "truecolor")).toBe(`\x1b[1mtexte${RESET}`);
  });
});
