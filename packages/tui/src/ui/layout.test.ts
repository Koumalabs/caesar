import { describe, expect, it } from "bun:test";
import { cell, layoutColumns, wrap } from "./layout";

const GUTTER = 2;

/** Ce que le terminal voit réellement : les largeurs, plus les gouttières entre elles. */
function occupied(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * GUTTER;
}

describe("layoutColumns", () => {
  it("une colonne n'est jamais plus étroite que son en-tête", () => {
    const widths = layoutColumns([{ header: "autorisation" }, { header: "id" }], 200);
    expect(widths[0]).toBeGreaterThanOrEqual("autorisation".length);
  });

  it("répartit l'excédent selon flex, et n'en perd pas une colonne en route", () => {
    const widths = layoutColumns([{ header: "a", flex: 1 }, { header: "b", flex: 3 }], 42);
    expect(occupied(widths)).toBe(42);
    // `flex` partage l'*excédent*, pas la largeur : les deux colonnes partent
    // du même plancher (4 caractères, en deçà desquels une cellule n'est plus
    // qu'une élision), et la seconde reçoit trois fois plus de ce qui reste.
    expect(widths[1]! - 4).toBe(3 * (widths[0]! - 4));
  });

  it("une colonne plafonnée cesse de grandir, et laisse les autres continuer", () => {
    // Sans plafond, la colonne « état » s'étirait à quarante caractères sur un
    // terminal large pour y afficher « 0.1.7 », en éloignant ses voisines.
    const widths = layoutColumns([{ header: "état", flex: 1, max: 12 }, { header: "capacités", flex: 1, max: 40 }], 200);
    expect(widths[0]).toBe(12);
    expect(widths[1]).toBe(40);
  });

  it("sans flex, laisse la place inutilisée plutôt que d'étirer arbitrairement", () => {
    const widths = layoutColumns([{ header: "agent", min: 10 }, { header: "version", min: 10 }], 200);
    expect(widths).toEqual([10, 10]);
  });

  it("quand la place manque, rabote toutes les colonnes plutôt que d'en sacrifier une", () => {
    const widths = layoutColumns([{ header: "agent", min: 20 }, { header: "binaire", min: 20 }, { header: "état", min: 20 }], 40);
    expect(occupied(widths)).toBeLessThanOrEqual(40);
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(4);
  });

  it("ne dépasse jamais la place disponible, quelle qu'elle soit", () => {
    const specs = [{ header: "agent", min: 12, flex: 1 }, { header: "binaire", flex: 3 }, { header: "politique", min: 12 }];
    for (let available = 20; available <= 220; available += 7) {
      expect(occupied(layoutColumns(specs, available))).toBeLessThanOrEqual(Math.max(available, 3 * 4 + 2 * GUTTER));
    }
  });
});

describe("cell", () => {
  it("complète à la largeur exacte", () => {
    expect(cell("ok", 5)).toBe("ok   ");
  });

  it("tronque avec une élision, sans jamais dépasser", () => {
    expect(cell("interminable", 5)).toBe("inte…");
    expect(cell("interminable", 5).length).toBe(5);
  });
});

describe("wrap", () => {
  it("replie sur les espaces, sans dépasser la largeur", () => {
    const lines = wrap("un motif de refus assez long pour ne pas tenir", 20);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toBe("un motif de refus assez long pour ne pas tenir");
  });

  it("coupe un mot plus long que la ligne — un chemin n'a pas d'espace où se replier", () => {
    const lines = wrap("/usr/local/share/quelque/chose/de/tres/long", 12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
    expect(lines.join("")).toBe("/usr/local/share/quelque/chose/de/tres/long");
  });

  it("préserve les retours à la ligne explicites", () => {
    expect(wrap("un\ndeux", 20)).toEqual(["un", "deux"]);
  });
});
