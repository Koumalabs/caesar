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
  /**
   * Arguments ajoutés à la ligne de commande quand la tâche a droit au
   * réseau — p. ex. `--allow-all-urls`. Les déclarer, c'est promettre que
   * *sans* eux le CLI est confiné : c'est ce qui fait passer la capacité
   * réseau de `"unknown"` à `"toggle"`. Mêmes jetons que `args`.
   */
  networkArgs?: string[];
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
  // Par défaut, on ne sait rien du réseau d'un CLI arbitraire — et « ne rien
  // savoir » n'est ni « ouvert » ni « fermé ». `createGenericAgent` remonte à
  // "toggle" dès que la déclaration porte des `networkArgs`.
  network: "unknown",
};

/**
 * Les jetons que `substitute` sait remplacer — donc les seuls qu'un gabarit
 * d'arguments puisse porter. Exportés parce que ce sont eux que valide
 * `validateGenericAgentSpec` et qu'affichent l'aide de `orch agents add` et
 * l'écran Agents du TUI : une liste unique, plutôt que trois recopies qui
 * divergeraient au premier jeton ajouté.
 */
export const GENERIC_ARG_TOKENS = ["prompt", "workspace", "taskDir", "reportPath", "model"] as const;
export type GenericArgToken = (typeof GENERIC_ARG_TOKENS)[number];

const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

/** Écrit `{{nom}}` — les messages d'erreur parlent des jetons sous la forme où on les tape. */
function tokenLiteral(name: string): string {
  return `{{${name}}}`;
}

function isGenericArgToken(name: string): name is GenericArgToken {
  return (GENERIC_ARG_TOKENS as readonly string[]).includes(name);
}

/** Les noms de jetons portés par `template`, dans l'ordre d'apparition, doublons compris. */
function tokensIn(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].map((match) => match[1] as string);
}

/**
 * Rend un gabarit d'argument en substituant ses jetons. Si l'un des jetons
 * qu'il contient n'a pas de valeur — inconnu, ou connu mais sans valeur pour
 * cette tâche (`{{model}}` quand aucun modèle n'est demandé) —, l'argument
 * entier disparaît plutôt que de laisser un `undefined` ou une chaîne vide
 * dans la ligne de commande.
 */
function substitute(template: string, tokens: Readonly<Record<GenericArgToken, string | undefined>>): string | undefined {
  let missing = false;
  const rendered = template.replace(TOKEN_PATTERN, (_match, name: string) => {
    const value = isGenericArgToken(name) ? tokens[name] : undefined;
    if (value === undefined) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? undefined : rendered;
}

function buildGeneric(spec: GenericAgentSpec, cwdMode: "process" | "flag", ctx: BuildContext): SpawnPlan {
  // Typé sur `GenericArgToken` — et non `Record<string, …>` — pour que
  // `GENERIC_ARG_TOKENS` et les jetons réellement substitués ici ne puissent
  // pas diverger sans que `tsc` le dise : ajouter un jeton à la liste sans
  // lui donner de valeur ici devient une erreur de compilation, plutôt qu'un
  // jeton accepté à la validation puis silencieusement absent au lancement
  // (un argument dont un jeton n'a pas de valeur disparaît entièrement).
  const tokens: Record<GenericArgToken, string | undefined> = {
    prompt: ctx.prompt,
    workspace: ctx.task.workspace,
    taskDir: ctx.paths.dir,
    reportPath: ctx.paths.reportPath,
    model: ctx.model,
  };

  const args: string[] = [];
  const templates = ctx.task.network ? [...spec.args, ...(spec.networkArgs ?? [])] : spec.args;
  for (const template of templates) {
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
 * Découpe une ligne de gabarit d'arguments en arguments, en respectant les
 * guillemets simples et doubles : `--system "tu es {{prompt}}"` fait deux
 * arguments, pas trois. Les interfaces qui déclarent un agent (`orch agents
 * add --args`, le champ « arguments » du TUI) saisissent une ligne unique —
 * c'est la forme sous laquelle on lit une ligne de commande — alors que
 * `GenericAgentSpec.args` est une liste : cette fonction et
 * `formatArgTemplate` font l'aller-retour, et sont ici plutôt que dans
 * chacune des deux interfaces pour qu'elles ne puissent pas diverger.
 *
 * Lève sur guillemet non refermé : le silence produirait un dernier argument
 * amputé de son délimiteur, donc une ligne de commande différente de celle
 * qu'on croit avoir écrite.
 */
export function splitArgTemplate(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      // Un argument entièrement vide entre guillemets ("") reste un argument :
      // `started` le distingue de l'absence d'argument.
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== null) {
    throw new Error(`Guillemet ${quote === '"' ? "double" : "simple"} non refermé dans les arguments : ${input}`);
  }
  if (started) args.push(current);
  return args;
}

/** Inverse de `splitArgTemplate` : recompose une ligne lisible, en ne mettant entre guillemets que ce qui en a besoin. */
export function formatArgTemplate(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg === "") return '""';
      if (!/[\s"']/.test(arg)) return arg;
      // Guillemets doubles par défaut ; simples si l'argument contient déjà
      // un guillemet double — `splitArgTemplate` ne connaît pas
      // l'échappement, donc on choisit le délimiteur plutôt que d'échapper.
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
    })
    .join(" ");
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Vérifie qu'une déclaration d'agent est utilisable, et rend le message
 * d'erreur à afficher plutôt qu'un booléen : les trois façons de se tromper
 * échouent toutes en silence à l'exécution, ce qui est précisément ce qu'il
 * faut éviter.
 *
 *  - un jeton mal orthographié (`{{promt}}`) fait *disparaître l'argument
 *    entier* de la ligne de commande (voir `substitute`) ;
 *  - un gabarit sans `{{prompt}}` lance l'agent sans jamais lui transmettre
 *    l'objectif de la tâche — il répond, mais à côté ;
 *  - un identifiant exotique casse la résolution par nom (`orch run --agent`)
 *    et les listes de rôles.
 *
 * Rend `null` quand tout va bien. Ne vérifie pas la présence du binaire :
 * c'est le travail de `findBinaryInPath`, et déclarer un agent pas encore
 * installé est légitime.
 */
export function validateGenericAgentSpec(spec: GenericAgentSpec): string | null {
  if (spec.id.trim().length === 0) return "L'identifiant de l'agent ne peut pas être vide.";
  if (!ID_PATTERN.test(spec.id)) {
    return `Identifiant d'agent invalide : "${spec.id}". Attendu des lettres, chiffres, ".", "_" ou "-", commençant par une lettre ou un chiffre.`;
  }
  if (spec.bin.trim().length === 0) {
    return `L'agent "${spec.id}" n'a pas de binaire : précisez la commande à lancer.`;
  }

  // Les arguments réseau passent par la même substitution que les autres :
  // ils méritent donc le même contrôle, sans quoi une coquille les ferait
  // disparaître en silence — et l'agent partirait sans réseau tout en
  // annonçant « réseau pilotable ».
  const allArgs = [...spec.args, ...(spec.networkArgs ?? [])];
  const unknown = [...new Set(allArgs.flatMap(tokensIn).filter((name) => !isGenericArgToken(name)))];
  if (unknown.length > 0) {
    return (
      `Jeton inconnu dans les arguments de "${spec.id}" : ${unknown.map(tokenLiteral).join(", ")}. ` +
      `Connus : ${GENERIC_ARG_TOKENS.map(tokenLiteral).join(", ")}. ` +
      `Un argument portant un jeton sans valeur disparaît entièrement de la ligne de commande.`
    );
  }

  if (!spec.args.some((arg) => arg.includes(tokenLiteral("prompt")))) {
    return (
      `Les arguments de "${spec.id}" ne contiennent pas ${tokenLiteral("prompt")} : ` +
      `l'agent serait lancé sans jamais recevoir l'objectif de la tâche.`
    );
  }

  return null;
}

/**
 * Construit un `AgentDefinition` pour un CLI arbitraire, décrit
 * déclarativement plutôt que par du code. Le format de sortie d'un tel CLI
 * est par construction inconnu : `translate` ne produit donc jamais
 * d'événement, et l'agent se contente du palier de rapport fichier (les
 * capacités non précisées valent `false`, `mcpInjection` vaut `"none"`).
 */
export function createGenericAgent(spec: GenericAgentSpec): AgentDefinition {
  const capabilities: AgentCapabilities = {
    ...NEUTRAL_CAPABILITIES,
    // `{{model}}` dans les arguments *est* tout le support du choix de modèle
    // pour un agent générique : rien d'autre ne le porte. La capacité s'en
    // déduit donc, au lieu de se déclarer séparément — où elle finirait par
    // contredire les arguments et annoncer, dans `orch agents list`, un choix
    // de modèle que la ligne de commande ne transmet nulle part.
    model: spec.args.some((arg) => arg.includes(tokenLiteral("model"))),
    // Même raisonnement que pour `model` : ce sont les `networkArgs` qui
    // *constituent* la capacité d'ouvrir le réseau, rien d'autre ne la porte.
    // La déduire ici plutôt que de la laisser déclarer séparément évite qu'un
    // agent annonce « réseau pilotable » dans `orch doctor` alors qu'aucun
    // argument ne l'ouvrirait.
    network: (spec.networkArgs?.length ?? 0) > 0 ? "toggle" : "unknown",
    ...spec.capabilities,
  };
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
