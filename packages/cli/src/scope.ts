/**
 * Resolution of the layer targeted by `--global`/`--local`, shared by the
 * subcommands that write (`policy allow|deny`, `agents enable|disable`,
 * `role add|remove`) — see the task 13 brief. Without an option: the
 * "project" layer, the behavior from before that task. `--global` and
 * `--local` are mutually exclusive — say it clearly rather than letting the
 * last option read win silently (`commander` does not do it for us: the two
 * flags are independent from its point of view).
 */
import type { ConfigScope } from "@caesar/core";

export interface ScopeOptions {
  global?: boolean;
  local?: boolean;
}

/** `{ error }` if `--global` and `--local` are given together; otherwise the targeted layer, "project" by default. */
export function resolveScope(options: ScopeOptions): ConfigScope | { error: string } {
  if (options.global && options.local) {
    return { error: '--global and --local are mutually exclusive: specify one or the other, never both.' };
  }
  if (options.global) return "global";
  if (options.local) return "local";
  return "project";
}

/** Human description of a layer, for confirmation messages ("... (<label> layer)."). */
export function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "global":
      return "global (~/.config/caesar/config.toml)";
    case "project":
      return "project (.caesar/config.toml)";
    case "local":
      return "local (.caesar/config.local.toml)";
  }
}

/** The flag to use to explicitly target `scope` from the command line — for messages steering toward the right layer. */
export function scopeFlagHint(scope: ConfigScope): string {
  switch (scope) {
    case "global":
      return "--global";
    case "project":
      return "without --global or --local (project layer, the default layer)";
    case "local":
      return "--local";
  }
}

/**
 * Message shown when a list (`allowed`/`denied`) was not declared by the
 * layer we just edited: it now takes over the entire list (see
 * `materializePolicyList`, `@caesar/core`) — editing a less specific layer
 * afterwards will no longer have any effect on this field here. Same
 * precedent as the warning already in place when an empty "allowed" list
 * becomes a restrictive one (`packages/cli/src/commands/policy.ts`).
 */
export function materializationNotice(field: "allowed" | "denied", scope: ConfigScope, effective: readonly string[]): string {
  return (
    `Warning: the "${field}" list was not declared by the ${scopeLabel(scope)} layer; it now takes it ` +
    `over with the current effective value (${effective.length > 0 ? effective.join(", ") : "empty"}) — ` +
    `editing a less specific layer (global or default) will no longer affect this field here.`
  );
}
