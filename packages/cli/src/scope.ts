/**
 * Résolution de la couche visée par `--global`/`--local`, partagée par les
 * sous-commandes qui écrivent (`policy allow|deny`, `agents enable|disable`,
 * `role add|remove`) — voir le brief de la tâche 13. Sans option : couche
 * "project", le comportement d'avant cette tâche. `--global` et `--local`
 * sont mutuellement exclusifs — le dire clairement plutôt que de laisser la
 * dernière option lue l'emporter en silence (`commander` ne le fait pas pour
 * nous : les deux flags sont indépendants de son point de vue).
 */
import type { ConfigScope } from "@caesar/core";

export interface ScopeOptions {
  global?: boolean;
  local?: boolean;
}

/** `{ error }` si `--global` et `--local` sont donnés ensemble ; sinon la couche visée, "project" par défaut. */
export function resolveScope(options: ScopeOptions): ConfigScope | { error: string } {
  if (options.global && options.local) {
    return { error: '--global et --local sont mutuellement exclusifs : précisez l\'un ou l\'autre, jamais les deux.' };
  }
  if (options.global) return "global";
  if (options.local) return "local";
  return "project";
}

/** Description humaine d'une couche, pour les messages de confirmation ("... (couche <label>)."). */
export function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "global":
      return "globale (~/.config/caesar/config.toml)";
    case "project":
      return "projet (.caesar/config.toml)";
    case "local":
      return "locale (.caesar/config.local.toml)";
  }
}

/** Le flag à utiliser pour cibler explicitement `scope` depuis la ligne de commande — pour les messages qui orientent vers la bonne couche. */
export function scopeFlagHint(scope: ConfigScope): string {
  switch (scope) {
    case "global":
      return "--global";
    case "project":
      return "sans --global ni --local (couche projet, la couche par défaut)";
    case "local":
      return "--local";
  }
}

/**
 * Message affiché quand une liste (`allowed`/`denied`) n'était pas déclarée
 * par la couche qu'on vient d'éditer : elle en prend désormais la main sur
 * la liste entière (voir `materializePolicyList`, `@caesar/core`) — modifier
 * ensuite une couche moins spécifique n'aura plus d'effet sur ce champ ici.
 * Même précédent que l'avertissement déjà en place quand une liste "allowed"
 * vide bascule en liste restrictive (`packages/cli/src/commands/policy.ts`).
 */
export function materializationNotice(field: "allowed" | "denied", scope: ConfigScope, effective: readonly string[]): string {
  return (
    `Attention : la liste "${field}" n'était pas déclarée par la couche ${scopeLabel(scope)} ; elle en prend ` +
    `désormais la main avec la valeur effective actuelle (${effective.length > 0 ? effective.join(", ") : "vide"}) — ` +
    `modifier une couche moins spécifique (global ou défaut) n'affectera plus ce champ ici.`
  );
}
