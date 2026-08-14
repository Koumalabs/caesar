/**
 * Accès réseau d'une tâche déléguée : ce que l'appelant demande, ce que
 * l'orchestrateur sait réellement obtenir de l'agent choisi, et ce qu'il faut
 * en dire quand les deux ne coïncident pas.
 *
 * Le défaut que ce module existe pour corriger : les cinq agents ne se
 * comportaient pas de la même façon et rien ne le disait. `codex exec` tourne
 * dans un bac à sable dont le réseau est coupé — une tâche « installe X » y
 * échouait sans explication — tandis que `claude`, `agy` et `opencode`, à qui
 * nos adaptateurs ne passent aucun confinement, l'avaient ouvert. La même
 * mission passait sur l'un et échouait sur l'autre.
 *
 * Comme `policy.ts`, ce module ne fait aucune E/S : il décide, et chaque
 * décision porte une phrase rédigée pour un humain. Un refus sans motif
 * remonterait tel quel à l'agent principal via MCP, où il serait
 * inexploitable.
 */
import type { TaskMode } from "@caesar/protocol";

/**
 * Ce que l'appelant demande — politique, rôle ou tâche. Même forme tri-état
 * que `isolation`.
 *
 * La liste est ici, et une seule fois : le schéma zod de la configuration
 * (`config.ts`) et la validation du drapeau `--network` (`packages/cli`) en
 * dérivent tous deux, plutôt que de la recopier chacun de leur côté — le
 * défaut que `flags.ts` documente déjà pour `--mode` et `--isolation`.
 */
export const NETWORK_REQUESTS = ["auto", "on", "off"] as const;
export type NetworkRequest = (typeof NETWORK_REQUESTS)[number];

/**
 * Ce que l'orchestrateur sait **piloter** chez un agent — pas ce que l'agent
 * sait faire. La distinction porte tout le module : `open` ne signifie pas
 * « cet agent a le réseau », mais « nous n'avons aucun moyen de le lui
 * retirer », ce qui interdit d'en faire une garantie.
 */
export type NetworkControl =
  /** Aucun confinement passé par notre adaptateur : le réseau est ouvert, nous ne savons pas le refermer. */
  | "open"
  /** Nous savons l'ouvrir, dans les deux modes. */
  | "toggle"
  /** Nous savons l'ouvrir, mais seulement en mode écriture — le cas de `codex`. */
  | "write-only"
  /** Nous ne savons rien du réseau de cet agent : un agent déclaré qui n'annonce pas d'arguments réseau. */
  | "unknown";

/**
 * `available` est la vérité de la tâche, aussi loin que nous puissions
 * l'affirmer : c'est elle qui est écrite sur la `Task` et lue par le brief.
 * Ce n'est pas « nous passons le drapeau d'ouverture » — pour un agent `open`
 * elle vaut vrai sans qu'aucun argument ne soit ajouté.
 *
 * Les adaptateurs, eux, n'ont pas besoin de plus : lorsqu'ils reçoivent
 * `available` à vrai, ils ajoutent leur drapeau si et seulement s'ils en ont
 * un. Un agent `write-only` ne peut pas la recevoir en lecture seule, la
 * décision l'ayant déjà ramenée à faux.
 */
export type NetworkDecision =
  | { refused: false; available: boolean; warning?: string }
  | { refused: true; reason: string; remedy: string };

export interface NetworkQuery {
  agentId: string;
  requested: NetworkRequest;
  mode: TaskMode;
  control: NetworkControl;
}

/**
 * Pourquoi un agent `write-only` ne peut rien pour une tâche en lecture seule,
 * et par où sortir. Vérifié sur codex 0.147.0 : son bac à sable expose
 * `sandbox_workspace_write.network_access`, et il n'existe aucun
 * `sandbox_read_only` — en `-s read-only`, le réseau est coupé sans recours.
 */
function writeOnlyRemedy(): string {
  return (
    `Relancez en écriture — "--mode write --isolation worktree" confine les modifications à une branche jetable, ` +
    `inspectable ensuite par "caesar diff" — ou choisissez un agent dont le réseau est déjà ouvert (antigravity, opencode).`
  );
}

/**
 * Résout la demande de réseau contre ce que l'agent choisi permet.
 *
 * La règle qui gouverne les cas limites : ne jamais laisser croire à une
 * garantie qui n'existe pas. Un `off` demandé à un agent que nous ne savons
 * pas confiner n'échoue pas — il s'exécute, mais le rapport dit que la
 * fermeture n'a pas eu lieu. C'est la même honnêteté que `describeAgentPolicy`
 * (policy.ts), qui refuse de suggérer un remède inopérant.
 *
 * `auto` (le défaut) et `on` ne diffèrent que sur un point, et c'est le point
 * qui compte : `auto` ouvre partout où c'est possible et se contente
 * d'avertir ailleurs, tandis que `on` refuse la délégation. Sans cette
 * distinction, un `on` posé comme défaut ferait échouer *toute* tâche en
 * lecture seule sur codex — les rôles `reviewer` et `investigator` livrés par
 * défaut cesseraient de fonctionner.
 */
export function decideNetwork(query: NetworkQuery): NetworkDecision {
  const { agentId, requested, mode, control } = query;

  if (requested === "off") {
    // `open` et `unknown` : le réseau reste ouvert (ou d'état inconnu) quoi
    // qu'on fasse. Le dire, plutôt que de rendre un `available: false` qui
    // décrirait une fermeture n'ayant pas eu lieu — et que le brief
    // répercuterait à l'agent sous forme de contrainte mensongère.
    if (control === "open" || control === "unknown") {
      return {
        refused: false,
        available: true,
        warning:
          `Réseau demandé fermé, mais l'orchestrateur ne sait pas le refermer pour "${agentId}" : ` +
          `la tâche s'exécute avec le réseau tel que le CLI de l'agent le laisse.`,
      };
    }
    return { refused: false, available: false };
  }

  switch (control) {
    case "open":
    case "toggle":
      return { refused: false, available: true };

    case "write-only":
      if (mode === "write") return { refused: false, available: true };
      if (requested === "on") {
        return {
          refused: true,
          reason: `Agent "${agentId}" ne sait ouvrir le réseau qu'en mode écriture : son bac à sable en lecture seule le coupe sans recours.`,
          remedy: writeOnlyRemedy(),
        };
      }
      // `auto` : la tâche part quand même, sans réseau, mais le rapport le
      // dit. C'est le cas courant (les rôles `reviewer` et `investigator` sur
      // codex) ; déclarer `network = "off"` sur le rôle rend l'intention
      // explicite et fait taire l'avertissement.
      return {
        refused: false,
        available: false,
        warning:
          `Réseau indisponible : "${agentId}" ne sait l'ouvrir qu'en mode écriture. ${writeOnlyRemedy()}`,
      };

    case "unknown":
      // Sous `auto`, l'appelant n'a rien exprimé : il n'y a rien à corriger,
      // donc rien à dire. Sous `on`, il attend une garantie que nous n'avons
      // pas — c'est là que l'avertissement gagne sa place.
      if (requested === "on") {
        return {
          refused: false,
          available: true,
          warning:
            `Réseau demandé, mais l'orchestrateur ne pilote pas celui de "${agentId}" : ` +
            `déclarez "network_args" sur cet agent pour qu'il sache l'ouvrir explicitement.`,
        };
      }
      return { refused: false, available: true };
  }
}

/** Libellé court d'une capacité réseau, pour `caesar doctor` et l'écran Agents. */
export function describeNetworkControl(control: NetworkControl): string {
  switch (control) {
    case "open":
      return "réseau ouvert";
    case "toggle":
      return "réseau pilotable";
    case "write-only":
      return "réseau en écriture seule";
    case "unknown":
      return "réseau inconnu";
  }
}
