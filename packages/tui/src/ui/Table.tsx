/**
 * Tableau à colonnes fluides : les largeurs se déduisent de la place réelle
 * (`layoutColumns`), une gouttière sépare toujours deux cellules, et chaque
 * valeur trop longue est tronquée dans la sienne.
 *
 * C'est le remplaçant des tableaux écrits à la main dans chaque écran, qui
 * complétaient les cellules à des largeurs constantes et sans séparateur —
 * une valeur tronquée venait alors coller à la suivante, et les deux se
 * lisaient comme un seul mot.
 *
 * La ligne sélectionnée porte un fond **et** un curseur "›" en gras : le fond
 * suppose un terminal sombre (voir `SELECTED_BG`), le curseur non. Ce fond
 * s'atténue quand le tableau n'a pas le focus, pour qu'une sélection
 * dormante ne dispute pas l'attention à celle qui reçoit les touches.
 */
import { TextAttributes } from "@opentui/core";
import { cell, layoutColumns } from "./layout";
import { DIM, SELECTED_BG, SELECTED_BG_IDLE } from "./theme";

export interface TableColumn<T> {
  header: string;
  /** Largeur minimale ; à défaut, la longueur de l'en-tête. */
  min?: number;
  /** Part de l'excédent de largeur. 0 (défaut) : la colonne garde son minimum. */
  flex?: number;
  /** Largeur au-delà de laquelle la colonne cesse de grandir (voir `layoutColumns`). */
  max?: number;
  cell: (row: T) => string;
  /** Couleur de la cellule — pour ce qui a un sens (installé, refusé…), jamais pour décorer. */
  fg?: (row: T) => string | undefined;
}

export interface TableProps<T> {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: readonly T[];
  keyOf: (row: T, index: number) => string;
  selectedIndex: number;
  /** Le tableau reçoit-il les touches — change l'intensité de la ligne sélectionnée. */
  focused?: boolean;
  /** Largeur disponible, gouttières comprises. */
  width: number;
  /** Affiché à la place des lignes quand il n'y en a aucune. */
  emptyText?: string;
}

const GUTTER = 2;

export function Table<T>({ columns, rows, keyOf, selectedIndex, focused = true, width, emptyText }: TableProps<T>) {
  // Deux caractères sont réservés au curseur en tête de ligne : sans cette
  // soustraction, la dernière colonne dépasserait du cadre exactement de sa
  // largeur, et le terminal replierait la ligne.
  const widths = layoutColumns(columns, Math.max(0, width - 2), GUTTER);
  const gap = " ".repeat(GUTTER);

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={DIM}>{"  "}</text>
        {columns.map((column, index) => (
          <text key={column.header} fg={DIM}>
            {(index > 0 ? gap : "") + cell(column.header, widths[index]!)}
          </text>
        ))}
      </box>

      {rows.length === 0 && emptyText ? <text fg={DIM}>{`  ${emptyText}`}</text> : null}

      {rows.map((row, rowIndex) => {
        const isSelected = rowIndex === selectedIndex;
        const bg = isSelected ? (focused ? SELECTED_BG : SELECTED_BG_IDLE) : undefined;
        return (
          <box key={keyOf(row, rowIndex)} flexDirection="row" backgroundColor={bg}>
            <text attributes={isSelected ? TextAttributes.BOLD : undefined}>{isSelected ? "› " : "  "}</text>
            {columns.map((column, index) => (
              <text
                key={column.header}
                fg={column.fg?.(row)}
                attributes={isSelected ? TextAttributes.BOLD : undefined}
              >
                {(index > 0 ? gap : "") + cell(column.cell(row), widths[index]!)}
              </text>
            ))}
          </box>
        );
      })}
    </box>
  );
}
