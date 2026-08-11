/**
 * Zone d'explication de hauteur constante, en pied de panneau : ce que fait
 * le champ sélectionné.
 *
 * La hauteur fixe est tout l'intérêt. Rendue en ligne, sous le champ, cette
 * explication décalait vers le bas tous les champs suivants dès qu'elle
 * apparaissait — descendre d'un cran faisait alors sauter la liste entière,
 * et l'œil perdait la ligne qu'il suivait. Ici la place est réservée une fois
 * pour toutes : le texte change, la mise en page ne bouge pas.
 */
import { wrap } from "./layout";
import { FAINT } from "./theme";

/** Deux lignes : assez pour une phrase complète, assez peu pour ne pas voler la place aux réglages. */
const LINES = 2;

export function Explain({ text, width }: { text?: string; width: number }) {
  const lines = text ? wrap(text, Math.max(20, width)).slice(0, LINES) : [];
  return (
    <box flexDirection="column" marginTop={1}>
      {Array.from({ length: LINES }, (_, index) => (
        <text key={index} fg={FAINT}>
          {lines[index] ?? " "}
        </text>
      ))}
    </box>
  );
}
