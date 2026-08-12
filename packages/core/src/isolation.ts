/**
 * Isolation d'une tâche en écriture : à quelles conditions un sous-agent a le
 * droit d'écrire directement dans le dépôt de l'utilisateur, plutôt que dans un
 * worktree jetable.
 *
 * Le défaut que ce module existe pour corriger : la chaîne de résolution
 * (`delegation.ts`) accordait à une demande explicite le dernier mot sur le
 * rôle et sur la politique, et `prepareIsolation` (`engine/runner.ts`)
 * l'honorait telle quelle — sans avertissement, sans constat dans le rapport.
 * Un `isolation: "inplace"` passé à `orch_delegate` défaisait donc en silence
 * le rôle `implementer`, qui impose pourtant `worktree`. Constaté sur un dépôt
 * réel : trois tâches déléguées ont écrit directement sur la branche de travail
 * de l'utilisateur, et rien dans leur rapport ne le disait.
 *
 * Le garde-fou existant, `mustForceWorktree`, ne couvre que la lecture seule :
 * il force le worktree pour qu'une écriture interdite soit *contenue et
 * détectée*. Ici la question est inverse — l'écriture est autorisée, c'est son
 * *emplacement* qui engage le dépôt de quelqu'un d'autre — et la réponse doit
 * l'être aussi : on refuse au lieu de rediriger. Rediriger silencieusement
 * l'écriture d'un agent vers un ailleurs que l'appelant n'a pas demandé serait
 * pire que de refuser : il attendrait ses modifications dans son arbre de
 * travail et ne les y trouverait pas.
 *
 * Comme `policy.ts` et `network.ts`, ce module ne fait aucune E/S : il décide,
 * et chaque refus porte un motif et un remède rédigés pour un humain — un refus
 * nu remonterait tel quel à l'agent principal via MCP, où il serait
 * inexploitable.
 */
import type { Isolation, TaskMode } from "@orch/protocol";

/**
 * D'où vient l'isolation retenue, le long de la chaîne
 * `argument explicite > rôle > politique` de `resolveDelegation`.
 *
 * N'entre pas dans la décision — seulement dans sa formulation. Un refus dont
 * le motif dit « demandée explicitement » alors que la valeur venait du défaut
 * de la politique enverrait l'utilisateur corriger le mauvais fichier.
 */
export type IsolationSource = "explicit" | "role" | "policy";

export interface InplaceWriteQuery {
  /** L'isolation retenue par la chaîne de résolution, `"auto"` compris. */
  requested: Isolation | "auto";
  mode: TaskMode;
  /**
   * Vrai seulement si le workspace est dans un dépôt git **portant au moins un
   * commit** — c'est-à-dire si un worktree y est réellement créable (voir
   * `usableRepoRoot`). Un dépôt sans commit n'a pas de `HEAD` d'où partir.
   */
  repoUsable: boolean;
  /** L'opt-in `policy.allow_inplace_write`, tel que l'appelant l'a transmis. */
  allowed: boolean;
  source?: IsolationSource;
  /** Racine du dépôt concerné, pour que le motif nomme ce qui est protégé. */
  repo?: string;
  /** Nom du rôle, quand `source` vaut `"role"`. */
  roleName?: string;
}

export type InplaceWriteDecision =
  | { refused: false }
  | { refused: true; reason: string; remedy: string };

/** « demandée explicitement », « héritée du rôle "implementer" », … */
function describeSource(source: IsolationSource | undefined, roleName?: string): string {
  switch (source) {
    case "explicit":
      return "demandée explicitement";
    case "role":
      return roleName ? `héritée du rôle "${roleName}"` : "héritée du rôle";
    case "policy":
      return 'héritée du défaut de la politique ("default_isolation")';
    default:
      return "retenue";
  }
}

/**
 * Décide si une tâche a le droit de s'exécuter en isolation `"inplace"`.
 *
 * Refuse **si et seulement si** les quatre conditions sont réunies :
 * `"inplace"` explicitement retenu, mode écriture, dépôt git utilisable, et
 * opt-in absent. Chacune mérite d'être lue comme une garde :
 *
 * - `requested === "inplace"` : `"auto"` n'est pas concerné, c'est
 *   `prepareIsolation` qui choisit pour lui — et il choisit déjà le worktree en
 *   écriture dès qu'il le peut.
 * - `mode === "write"` : la lecture seule relève de `mustForceWorktree`, dont la
 *   logique est opposée (contenir, pas interdire).
 * - `repoUsable` : sans dépôt utilisable, aucun worktree n'est possible.
 *   Refuser ici rendrait `orch` inutilisable sur tout projet non versionné ou
 *   fraîchement initialisé — un durcissement qui casse le cas ordinaire n'est
 *   pas un durcissement, c'est une panne. `prepareIsolation` avertit déjà pour
 *   ce cas.
 * - `!allowed` : l'opt-in `policy.allow_inplace_write` existe pour les dépôts où
 *   l'utilisateur assume le risque en connaissance de cause.
 *
 * La fonction est appelée deux fois sur le même trajet — tôt dans
 * `resolveDelegation`, pour refuser avant qu'aucun répertoire de tâche ne soit
 * écrit sur le disque, et de nouveau dans `prepareIsolation`, seul point que
 * *toutes* les façades traversent, y compris un appel direct à `runTask`. Elle
 * est pure : les deux appels rendent nécessairement le même verdict.
 */
export function decideInplaceWrite(query: InplaceWriteQuery): InplaceWriteDecision {
  const { requested, mode, repoUsable, allowed } = query;

  if (requested !== "inplace" || mode !== "write" || !repoUsable || allowed) {
    return { refused: false };
  }

  const where = query.repo ? ` du dépôt "${query.repo}"` : "";
  return {
    refused: true,
    reason:
      `Isolation "inplace" ${describeSource(query.source, query.roleName)} pour une tâche en écriture : refusée. ` +
      `Le sous-agent écrirait directement dans l'arbre de travail${where}, sur la branche courante — ` +
      `ses modifications se mêleraient aux vôtres et à celles des autres tâches, sans que "orch diff" puisse en rendre compte.`,
    remedy:
      `Laissez l'isolation à "worktree" (ou "auto") : le sous-agent travaille alors sur une branche jetable, ` +
      `dont "orch diff" montre le résultat et "orch apply" le reporte. Si le worktree est inexploitable parce qu'il ` +
      `manque des fichiers non suivis par git (dépendances installées, ".env", briefs ignorés), déclarez-les sous ` +
      `[worktree] dans ".orch/config.toml" (clés "copy", "link", "setup") plutôt que de renoncer à l'isolation. ` +
      `En dernier recours, et en connaissance de cause, posez "allow_inplace_write = true" sous [policy].`,
  };
}
