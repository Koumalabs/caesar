/**
 * Le défaut que ce tableau existe pour corriger se vérifie à l'œil sur la
 * grille rendue : deux cellules voisines ne doivent jamais se toucher, et
 * aucune ligne ne doit dépasser la largeur du terminal (au-delà, le terminal
 * replie, et la vue d'ensemble devient illisible là où elle devait
 * renseigner).
 */
import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { useTerminalDimensions } from "@opentui/react";
import { Table } from "./Table";

interface Row {
  id: string;
  path: string;
  version: string;
}

const ROWS: Row[] = [
  { id: "codex", path: "/Users/quelquun/.local/share/mise/installs/node/22.11.0/bin/codex", version: "0.1.7" },
  { id: "antigravity", path: "/Users/quelquun/.local/bin/antigravity", version: "1.1.11" },
];

const COLUMNS = [
  { header: "agent", min: 12, cell: (row: Row) => row.id },
  { header: "binaire", flex: 1, cell: (row: Row) => row.path },
  { header: "version", min: 10, cell: (row: Row) => row.version },
];

/** Le composant sous test lit la largeur réelle du terminal, comme les écrans. */
function Harness() {
  const { width } = useTerminalDimensions();
  return <Table columns={COLUMNS} rows={ROWS} keyOf={(row) => row.id} selectedIndex={0} width={width} />;
}

async function frameAt(width: number): Promise<{ frame: string; destroy: () => void }> {
  const setup = await act(async () => testRender(<Harness />, { width, height: 12 }));
  await act(async () => setup.renderOnce());
  return { frame: setup.captureCharFrame(), destroy: () => setup.renderer.destroy() };
}

describe("Table", () => {
  it("sépare toujours deux colonnes, même quand la valeur de gauche est tronquée", async () => {
    const { frame, destroy } = await frameAt(60);
    const line = frame.split("\n").find((candidate) => candidate.includes("codex"))!;

    // Le chemin ne tient pas : il est coupé. L'élision doit être suivie d'un
    // espace, jamais directement de la version — c'est exactement le défaut
    // constaté ("…codex-cli 0.1…7 notable(s)").
    expect(line).toContain("…");
    expect(line).not.toMatch(/…\S/);
    expect(line).toContain("0.1.7");
    destroy();
  });

  it("occupe la largeur disponible plutôt qu'une largeur écrite en dur", async () => {
    const étroit = await frameAt(60);
    const large = await frameAt(160);

    // Sur un terminal large, la colonne flexible s'étend : le chemin qui
    // était tronqué à 60 colonnes tient en entier à 160.
    expect(étroit.frame).not.toContain("/Users/quelquun/.local/bin/antigravity");
    expect(large.frame).toContain("/Users/quelquun/.local/bin/antigravity");
    étroit.destroy();
    large.destroy();
  });

  it("aucune ligne ne dépasse la largeur du terminal", async () => {
    for (const width of [40, 80, 200]) {
      const { frame, destroy } = await frameAt(width);
      for (const line of frame.split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(width);
      destroy();
    }
  });
});
