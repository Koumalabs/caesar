/**
 * Barre de touches contextuelle : ce qu'on peut taper **maintenant**, à
 * l'endroit où on est.
 *
 * L'ancien écran affichait une ligne d'aide figée, identique qu'on parcoure
 * la liste ou qu'on édite un champ — donc fausse la moitié du temps, et
 * illisible tout le temps (tout en gris, touches et libellés confondus dans
 * la même phrase). Ici la touche est un pavé contrasté et le libellé un texte
 * secondaire : l'œil trouve les touches sans lire la phrase.
 *
 * Chaque écran rend cette barre lui-même, en fonction de son niveau de focus
 * courant : c'est lui qui sait ce que "Entrée" fait à cet instant.
 */
import { DIM, KEY_BG, KEY_FG } from "./theme";

export interface Hint {
  key: string;
  label: string;
}

export function KeyHints({ hints }: { hints: readonly Hint[] }) {
  return (
    <box flexDirection="row" flexWrap="wrap">
      {hints.map((hint) => (
        <box key={`${hint.key}:${hint.label}`} flexDirection="row" marginRight={2}>
          <text bg={KEY_BG} fg={KEY_FG}>{` ${hint.key} `}</text>
          <text fg={DIM}>{` ${hint.label}`}</text>
        </box>
      ))}
    </box>
  );
}
