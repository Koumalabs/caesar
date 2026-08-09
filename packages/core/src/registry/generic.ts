import type { ReportChannel, Task } from "@orch/protocol";
import type { AgentCapabilities, AgentDefinition, BuildContext, SpawnPlan, Translation } from "./types.js";
import { defaultPreferredReportChannel } from "./types.js";

export interface GenericAgentSpec {
  id: string;
  displayName?: string;
  bin: string;
  /** Gabarit d'arguments. Les jetons {{prompt}}, {{workspace}}, {{taskDir}}, {{reportPath}}, {{model}} sont substitués. */
  args: string[];
  /** "process" : le cwd porte le workspace. "flag" : il est déjà dans args. */
  cwdMode?: "process" | "flag";
  capabilities?: Partial<AgentCapabilities>;
}

const NEUTRAL_CAPABILITIES: AgentCapabilities = {
  jsonEvents: false,
  outputSchema: false,
  finalMessageFile: false,
  nativeReadOnly: false,
  resume: false,
  addDir: false,
  mcpInjection: "none",
  model: false,
};

const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Rend un gabarit d'argument en substituant ses jetons. Si l'un des jetons
 * qu'il contient n'a pas de valeur, l'argument entier disparaît plutôt que
 * de laisser un `undefined` ou une chaîne vide dans la ligne de commande.
 */
function substitute(template: string, tokens: Record<string, string | undefined>): string | undefined {
  let missing = false;
  const rendered = template.replace(TOKEN_PATTERN, (_match, name: string) => {
    const value = tokens[name];
    if (value === undefined) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? undefined : rendered;
}

function buildGeneric(spec: GenericAgentSpec, cwdMode: "process" | "flag", ctx: BuildContext): SpawnPlan {
  const tokens: Record<string, string | undefined> = {
    prompt: ctx.prompt,
    workspace: ctx.task.workspace,
    taskDir: ctx.paths.dir,
    reportPath: ctx.paths.reportPath,
    model: ctx.model,
  };

  const args: string[] = [];
  for (const template of spec.args) {
    const rendered = substitute(template, tokens);
    if (rendered !== undefined) args.push(rendered);
  }
  args.push(...ctx.extraArgs);

  return {
    command: spec.bin,
    args,
    // "flag" : le workspace est déjà porté par un jeton dans args (p. ex.
    // --dir {{workspace}}) ; le process tourne depuis le répertoire de tâche
    // plutôt que de dupliquer inutilement le cwd sur le workspace.
    cwd: cwdMode === "process" ? ctx.task.workspace : ctx.paths.dir,
    env: {},
    files: [],
  };
}

/**
 * Construit un `AgentDefinition` pour un CLI arbitraire, décrit
 * déclarativement plutôt que par du code. Le format de sortie d'un tel CLI
 * est par construction inconnu : `translate` ne produit donc jamais
 * d'événement, et l'agent se contente du palier de rapport fichier (les
 * capacités non précisées valent `false`, `mcpInjection` vaut `"none"`).
 */
export function createGenericAgent(spec: GenericAgentSpec): AgentDefinition {
  const capabilities: AgentCapabilities = { ...NEUTRAL_CAPABILITIES, ...spec.capabilities };
  const cwdMode = spec.cwdMode ?? "process";

  return {
    id: spec.id,
    displayName: spec.displayName ?? spec.id,
    bin: spec.bin,
    capabilities,
    preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
      defaultPreferredReportChannel(capabilities, channelAvailable),
    build: (ctx: BuildContext): SpawnPlan => buildGeneric(spec, cwdMode, ctx),
    translate: (): Translation => ({ events: [] }),
  };
}
