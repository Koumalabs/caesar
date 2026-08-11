/**
 * Cadre titré dont la bordure dit s'il a le focus — la réponse à « où
 * suis-je ? », que l'ancien écran ne donnait nulle part : deux curseurs "›"
 * pouvaient être visibles en même temps (la liste des rôles et la liste des
 * champs) sans que rien ne distingue celui qui recevait les touches.
 *
 * `note` s'affiche en tête du contenu plutôt que dans le titre : OpenTUI
 * n'aligne un titre qu'à gauche, au centre ou à droite, et un titre composite
 * (« implementer — hérité ← global ») déborde du cadre dès que le nom
 * s'allonge.
 */
import type { ReactNode } from "react";
import { ACCENT, DIM, FAINT } from "./theme";

export interface PanelProps {
  title: string;
  /** Vrai quand ce panneau reçoit les touches — sa bordure et son titre s'allument. */
  focused?: boolean;
  /** Précision affichée en première ligne, en retrait (provenance, rappel de règle…). */
  note?: string;
  width?: number;
  flexGrow?: number;
  children?: ReactNode;
}

export function Panel({ title, focused = false, note, width, flexGrow, children }: PanelProps) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? ACCENT : FAINT}
      title={` ${title} `}
      titleColor={focused ? ACCENT : DIM}
      paddingLeft={1}
      paddingRight={1}
      // Un panneau plus haut que la place restante débordait sur ses voisins
      // — les caractères se superposaient et la frame devenait illisible.
      // Sur un terminal trop court, mieux vaut couper net que brouiller.
      overflow="hidden"
      // Un panneau ne se laisse jamais comprimer : privé de sa hauteur, yoga
      // ramène ses lignes les unes sur les autres et le texte se superpose,
      // illisible. Il garde donc la hauteur de son contenu, et c'est le corps
      // de l'écran (`overflow: hidden`) qui coupe ce qui dépasse.
      flexShrink={0}
      {...(width !== undefined ? { width } : {})}
      {...(flexGrow !== undefined ? { flexGrow } : {})}
    >
      {note ? <text fg={DIM}>{note}</text> : null}
      {children}
    </box>
  );
}
