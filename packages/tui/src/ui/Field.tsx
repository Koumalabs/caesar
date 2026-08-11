/**
 * Ligne « libellé — valeur » alignée, brique des panneaux d'édition.
 *
 * L'ancienne mise en forme posait la valeur *sous* son libellé, en retrait de
 * deux espaces : six champs occupaient dix-huit lignes, sans qu'aucune
 * colonne ne se lise verticalement. Ici le libellé tient une colonne de
 * largeur fixe et la valeur commence toujours au même endroit — on parcourt
 * les valeurs d'un seul regard.
 *
 * Une valeur plus longue que la place restante se replie sous elle-même
 * (`wrap`), alignée sur la colonne des valeurs : c'est ce qui manquait au
 * motif d'un refus de politique, qui partait jusqu'ici hors de l'écran.
 *
 * L'explication du champ, elle, ne vit **pas** ici : elle s'affiche en pied
 * de panneau, à hauteur constante (`Explain`). Rendue en ligne, elle
 * décalait tous les champs suivants dès qu'elle apparaissait — la liste
 * entière sautait à chaque déplacement du curseur.
 */
import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { wrap } from "./layout";
import { ACCENT, DIM, FAINT } from "./theme";

export interface FieldProps {
  label: string;
  /** Largeur totale disponible pour la ligne (libellé + valeur). */
  width: number;
  /** Largeur de la colonne des libellés — commune à tous les champs d'un même panneau. */
  labelWidth: number;
  selected?: boolean;
  /** Marque d'héritage déjà formatée (« ← global »), affichée en fin de première ligne. */
  mark?: string;
  value?: string;
  /** Couleur de la valeur, pour ce qui en porte une (activé/désactivé, retenu…). */
  valueFg?: string;
  /** Rendu à la place de la valeur, sur la même ligne — un champ de saisie, typiquement. */
  children?: ReactNode;
  /** Rendu sous la ligne, aligné sur la colonne des valeurs — une sous-liste, typiquement. */
  below?: ReactNode;
}

export function Field({ label, width, labelWidth, selected = false, mark, value, valueFg, children, below }: FieldProps) {
  const valueWidth = Math.max(8, width - labelWidth - 2);
  const lines = value === undefined ? [] : wrap(value, valueWidth);

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={selected ? ACCENT : DIM} attributes={selected ? TextAttributes.BOLD : undefined}>
          {(selected ? "› " : "  ") + label.padEnd(labelWidth)}
        </text>
        {children ?? <text fg={valueFg}>{lines[0] ?? ""}</text>}
        {mark ? <text fg={FAINT}>{mark}</text> : null}
      </box>

      {lines.slice(1).map((line, index) => (
        <box key={index} flexDirection="row">
          <text>{" ".repeat(labelWidth + 2)}</text>
          <text fg={valueFg}>{line}</text>
        </box>
      ))}

      {below}
    </box>
  );
}
