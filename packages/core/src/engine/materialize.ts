/**
 * L'atelier : ce qu'il faut ajouter à un worktree git fraîchement créé pour
 * qu'un sous-agent puisse réellement y travailler.
 *
 * Un worktree ne contient que les fichiers **suivis**. Les dépendances
 * installées, le `.env`, les répertoires ignorés portant des briefs ou des
 * artefacts n'y sont pas — rien ne s'y installe, rien ne s'y lance, rien ne
 * s'y vérifie. L'isolation devenait donc, sur un projet réel, un espace vide
 * dans lequel il n'y avait rien à faire, et la contourner par
 * `isolation = "inplace"` restait la seule issue praticable. C'est la cause de
 * fond du défaut que `isolation.ts` corrige de l'autre côté : durcir la règle
 * sans rendre le worktree habitable n'aurait fait que déplacer le
 * contournement d'un cran.
 *
 * Ce module est l'étape « Project Setup » du skill
 * `superpowers:using-git-worktrees`, appliquée à un tiers plutôt qu'à soi : ce
 * n'est pas l'agent qui monte son atelier — il n'en connaît ni les chemins ni
 * les commandes —, c'est l'orchestrateur qui le lui livre monté, à partir de
 * ce que le projet a déclaré sous `[worktree]`.
 *
 * Rien ici ne lève pour une raison d'exécution : un chemin absent, suivi,
 * non ignoré ou déjà présent produit un **constat** que le rapport porte, pas
 * un échec. Seule une configuration invalide lève — parce que c'en est une.
 */
import { execFile } from "node:child_process";
import { access, cp, mkdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorktreeConfig } from "../config.js";

const execFileAsync = promisify(execFile);

/** Comment un chemin a été posé dans le worktree. */
export type MaterializeVia =
  /** Clone copy-on-write (APFS, Btrfs, XFS…) : instantané, isolé, sans coût disque immédiat. */
  | "clone"
  /** Copie récursive ordinaire : isolée, mais elle coûte son poids en temps et en octets. */
  | "copy"
  /** Lien symbolique : partagé avec le workspace, donc **pas** isolé. */
  | "link";

export interface MaterializedPath {
  path: string;
  via: MaterializeVia;
}

/** Pourquoi un chemin déclaré n'a pas été posé. Chacune de ces raisons est bénigne — et chacune mérite d'être dite. */
export type SkipReason =
  /** Le chemin n'existe pas dans le workspace : rien à poser. */
  | "absent"
  /** Suivi par git : il est déjà dans le worktree, avec le bon contenu. */
  | "tracked"
  /** Ni suivi ni ignoré par git : le poser polluerait le diff qui fait foi. */
  | "not-ignored"
  /** Déjà présent dans le worktree (posé par une commande de setup, ou par git). */
  | "already-present";

export interface SkippedPath {
  path: string;
  reason: SkipReason;
  /** Phrase prête à lire, disant pourquoi et — quand il y a lieu — quoi faire. */
  detail: string;
}

export interface MaterializeResult {
  materialized: MaterializedPath[];
  skipped: SkippedPath[];
  /**
   * Les chemins effectivement posés, à exclure du diff de la tâche : ce que
   * l'orchestrateur a lui-même déposé n'est pas le travail de l'agent, et un
   * `.env` recopié n'a rien à faire dans un `caesar apply`.
   */
  excluded: string[];
  /**
   * Ce qui n'est pas isolé — les chemins posés en lien. Vide dans le cas
   * normal ; non vide, c'est un constat que le rapport doit porter, parce que
   * deux tâches simultanées y écrivent au même endroit, et que ce qu'elles y
   * cassent, elles le cassent pour le workspace.
   */
  shared: string[];
}

/**
 * Refuse un chemin qui n'a pas sa place dans `[worktree]`. Le schéma de
 * configuration (`WorktreePathSchema`) applique déjà ces règles au chargement
 * du TOML ; les répéter ici couvre les appelants qui construisent une
 * `WorktreeConfig` en mémoire, et fait de l'invariant une propriété du module
 * plutôt qu'une propriété du fichier.
 */
function assertRelativeInsidePath(path: string): void {
  if (path === "" || isAbsolute(path)) {
    throw new Error(`Chemin "${path}" invalide dans [worktree] : attendu un chemin relatif à la racine du workspace.`);
  }
  const segments = path.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Chemin "${path}" invalide dans [worktree] : un segment ".." sortirait du workspace.`);
  }
  if (segments[0] === ".git" || segments[0] === ".caesar") {
    throw new Error(
      `Chemin "${path}" invalide dans [worktree] : ".git" et ".caesar" sont l'administration du dépôt et celle de caesar, ` +
        `le worktree existe précisément pour ne pas y toucher.`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Vrai si git suit au moins un fichier sous `path` (fichier ou répertoire). */
async function isTracked(repo: string, path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "ls-files", "--", path]);
    return stdout.trim() !== "";
  } catch {
    return false;
  }
}

/** Vrai si git ignore `path` (`.gitignore`, `.git/info/exclude`, configuration globale). */
async function isIgnored(repo: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repo, "check-ignore", "-q", "--", path]);
    return true;
  } catch {
    // Code de sortie 1 : non ignoré. Tout autre code (128, hors dépôt) mène
    // à la même conclusion prudente — on ne pose rien dont on ne sait pas que
    // git le laissera hors du diff.
    return false;
  }
}

/**
 * Copie `source` vers `target` en privilégiant le clone copy-on-write du
 * système de fichiers, et rend le mécanisme réellement employé.
 *
 * Le clone ne duplique aucun octet tant que personne n'écrit, ce qui rend
 * l'isolation par copie abordable là où elle serait autrement hors de prix.
 * Ce n'est pas gratuit pour autant — le parcours de l'arborescence reste à
 * faire. Mesuré sur un `node_modules` de 975 Mo (~100 000 fichiers, APFS) :
 * 6,3 s et 11 Mo de disque, contre 15,0 s et 994 Mo pour une copie ordinaire.
 * Le clone reste une **vraie** copie du point de vue de l'agent : deux tâches
 * simultanées ne partagent rien, et détruire le `node_modules` du worktree ne
 * touche pas celui du workspace.
 *
 * `cp -c` (darwin) échoue franchement quand le clonefile est impossible —
 * système de fichiers sans copy-on-write, ou traversée de volumes — d'où le
 * repli explicite. Sur Linux, `--reflink=auto` retombe seul sur une copie
 * ordinaire, mais on ne peut alors plus distinguer les deux : le repli
 * `fs.cp` est employé partout ailleurs, et sa lenteur éventuelle est un fait
 * que le rapport dira plutôt qu'un échec.
 */
async function copyTree(source: string, target: string): Promise<MaterializeVia> {
  if (process.platform === "darwin") {
    try {
      await execFileAsync("/bin/cp", ["-Rc", source, target]);
      return "clone";
    } catch {
      // Pas de clonefile possible ici : on copie pour de bon.
    }
  } else if (process.platform === "linux") {
    try {
      await execFileAsync("cp", ["-R", "--reflink=auto", source, target]);
      // `auto` a pu retomber sur une copie ordinaire sans le dire : on
      // n'annonce donc pas un clone qui n'a peut-être pas eu lieu.
      return "copy";
    } catch {
      // `cp` absent ou refusé : `fs.cp` ci-dessous.
    }
  }
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  return "copy";
}

/**
 * Pose dans `worktree` les chemins non suivis que `request` déclare, en les
 * prenant dans `workspace`.
 *
 * L'ordre des vérifications, par chemin, n'est pas indifférent :
 *
 * 1. **chemin invalide** ⇒ lève, c'est une erreur de configuration ;
 * 2. **absent du workspace** ⇒ écarté, il n'y a rien à poser ;
 * 3. **suivi par git** ⇒ écarté, et c'est le plus important : le worktree en a
 *    déjà sa version, et poser un lien par-dessus ferait écrire le sous-agent
 *    **dans le dépôt principal** — précisément le défaut qu'on corrige ;
 * 4. **non ignoré par git** ⇒ écarté : le poser le ferait apparaître dans
 *    `caesar diff`, qui fait foi, et `worktreeHasChanges` verrait le worktree
 *    sale à vie, si bien que `caesar gc` ne le nettoierait jamais ;
 * 5. **déjà présent dans le worktree** ⇒ écarté, on n'écrase rien ;
 * 6. sinon **posé**, par clone, copie ou lien.
 *
 * `link` est traité après `copy` : si un même chemin figure dans les deux, la
 * copie l'emporte, puisqu'elle isole — et le lien est alors écarté en
 * `already-present`, ce que le rapport dira.
 */
export async function materializeUntracked(
  workspace: string,
  worktree: string,
  request: WorktreeConfig,
): Promise<MaterializeResult> {
  const materialized: MaterializedPath[] = [];
  const skipped: SkippedPath[] = [];
  const shared: string[] = [];

  const plan: { path: string; mode: "copy" | "link" }[] = [
    ...request.copy.map((path) => ({ path, mode: "copy" as const })),
    ...request.link.map((path) => ({ path, mode: "link" as const })),
  ];
  for (const entry of plan) assertRelativeInsidePath(entry.path);

  for (const { path, mode } of plan) {
    const from = join(workspace, path);
    const to = join(worktree, path);

    if (!(await exists(from))) {
      skipped.push({
        path,
        reason: "absent",
        detail: `"${path}" est déclaré sous [worktree] mais n'existe pas dans le workspace : rien à poser.`,
      });
      continue;
    }
    if (await isTracked(workspace, path)) {
      skipped.push({
        path,
        reason: "tracked",
        detail:
          `"${path}" est suivi par git : le worktree en a déjà sa version. Le poser par-dessus ferait écrire ` +
          `le sous-agent dans le dépôt principal — retirez-le de [worktree].`,
      });
      continue;
    }
    if (!(await isIgnored(workspace, path))) {
      skipped.push({
        path,
        reason: "not-ignored",
        detail:
          `"${path}" n'est ni suivi ni ignoré par git : le poser le ferait apparaître dans "caesar diff" comme un ` +
          `changement de l'agent, et "caesar gc" ne nettoierait plus jamais ce worktree. Ajoutez-le au .gitignore, ` +
          `ou retirez-le de [worktree].`,
      });
      continue;
    }
    if (await exists(to)) {
      skipped.push({
        path,
        reason: "already-present",
        detail: `"${path}" est déjà présent dans le worktree : laissé tel quel, rien n'est écrasé.`,
      });
      continue;
    }

    // Le chemin peut être imbriqué (`packages/api/node_modules`) et son parent
    // n'exister dans le worktree que s'il porte des fichiers suivis.
    await mkdir(dirname(to), { recursive: true });

    if (mode === "link") {
      await symlink(resolve(from), to);
      materialized.push({ path, via: "link" });
      shared.push(path);
    } else {
      materialized.push({ path, via: await copyTree(from, to) });
    }
  }

  return { materialized, skipped, excluded: materialized.map((entry) => entry.path), shared };
}

export interface SetupFailure {
  command: string;
  exitCode: number | null;
  /** Sortie standard et d'erreur réunies, tronquée — collée telle quelle dans le motif d'échec. */
  output: string;
}

export interface SetupResult {
  /** Les commandes menées à bien, dans l'ordre. */
  ran: string[];
  /** La première commande en échec, s'il y en a une : les suivantes n'ont pas été lancées. */
  failure?: SetupFailure;
}

/** Au-delà, la sortie d'une commande de setup cesse d'aider à comprendre l'échec. */
const SETUP_OUTPUT_LIMIT = 4000;

function tail(text: string): string {
  return text.length <= SETUP_OUTPUT_LIMIT ? text : `…\n${text.slice(-SETUP_OUTPUT_LIMIT)}`;
}

/**
 * Lance les commandes de `[worktree] setup` dans le worktree, dans l'ordre,
 * et s'arrête à la première qui échoue.
 *
 * Par un shell, et non par un découpage d'arguments : ce que les projets
 * écrivent ici ressemble à `npm ci && npm run build`, avec redirections et
 * enchaînements. C'est du même niveau de confiance que `[[agent]] bin`, que
 * l'orchestrateur exécute déjà — la configuration d'un projet est du code que
 * son auteur choisit de faire tourner chez lui.
 *
 * L'échec n'est pas rattrapé ici : c'est l'appelant qui décide qu'une tâche
 * dont l'atelier n'a pas pu être monté ne doit pas démarrer. Mieux vaut ne pas
 * commencer que confier à l'agent un atelier à moitié monté, où il passerait
 * son budget à réparer une installation plutôt qu'à faire son travail.
 */
export async function runSetup(worktree: string, commands: readonly string[], signal?: AbortSignal): Promise<SetupResult> {
  const ran: string[] = [];
  for (const command of commands) {
    try {
      await execFileAsync(shellBin(), [...shellArgs(), command], {
        cwd: worktree,
        ...(signal ? { signal } : {}),
        maxBuffer: 16 * 1024 * 1024,
      });
      ran.push(command);
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      const output = tail([failure.stdout ?? "", failure.stderr ?? ""].filter(Boolean).join("\n").trim() || (failure.message ?? ""));
      return { ran, failure: { command, exitCode: typeof failure.code === "number" ? failure.code : null, output } };
    }
  }
  return { ran };
}

function shellBin(): string {
  return process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : "/bin/sh";
}

function shellArgs(): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
}

/**
 * Ce qu'un projet donne à voir de ses besoins d'atelier : par marqueur
 * reconnu, les chemins à emporter et la commande d'installation usuelle.
 *
 * Volontairement court et conventionnel. Une détection exhaustive se
 * tromperait plus souvent qu'elle n'aiderait — et un `[worktree]` écrit une
 * fois par `caesar init` se relit et se corrige à la main, ce qui n'est vrai
 * d'aucune heuristique appliquée à chaque exécution.
 */
const PROJECT_MARKERS: { marker: string; copy: string[]; setup?: string }[] = [
  { marker: "pnpm-lock.yaml", copy: ["node_modules"], setup: "pnpm install --frozen-lockfile --prefer-offline" },
  { marker: "yarn.lock", copy: ["node_modules"], setup: "yarn install --immutable" },
  { marker: "package-lock.json", copy: ["node_modules"], setup: "npm ci" },
  { marker: "package.json", copy: ["node_modules"], setup: "npm install" },
  { marker: "Cargo.toml", copy: ["target"] },
  { marker: "poetry.lock", copy: [".venv"], setup: "poetry install" },
  { marker: "pyproject.toml", copy: [".venv"] },
  { marker: "requirements.txt", copy: [".venv"] },
  { marker: "go.mod", copy: [] },
];

/** Chemins non versionnés fréquents, sans rapport avec un écosystème : emportés s'ils existent et sont ignorés. */
const COMMON_UNTRACKED = [".env", ".env.local"];

/**
 * Devine ce que le worktree d'un projet devrait emporter, pour que `caesar init`
 * écrive un `[worktree]` déjà utile plutôt qu'une section vide à remplir.
 *
 * Ne propose **que** ce qui existe réellement dans le workspace et que git
 * ignore : proposer un chemin suivi rouvrirait le défaut que
 * `materializeUntracked` refuse (l'agent écrirait dans le dépôt principal), et
 * proposer un chemin ni suivi ni ignoré polluerait le diff. La détection
 * applique donc, en amont, exactement les mêmes règles que la pose.
 *
 * Un projet nu ne produit rien du tout — `caesar init` n'écrit alors aucune
 * section, plutôt qu'une section vide qui ferait croire à un réglage.
 * `setup` est le seul champ que la détection puisse proposer à tort : une
 * commande d'installation est une convention, pas un fait, et c'est à ce titre
 * qu'elle est écrite en clair dans le fichier, où elle se corrige.
 */
export async function detectUntrackedNeeds(workspace: string): Promise<WorktreeConfig | null> {
  const copy: string[] = [];
  const setup: string[] = [];

  for (const { marker, copy: paths, setup: command } of PROJECT_MARKERS) {
    if (!(await exists(join(workspace, marker)))) continue;
    for (const path of paths) {
      if (!copy.includes(path) && (await isUsableUntracked(workspace, path))) copy.push(path);
    }
    if (command && !setup.includes(command)) setup.push(command);
    // Un seul écosystème par famille : les marqueurs sont ordonnés du plus
    // spécifique au plus général (`pnpm-lock.yaml` avant `package.json`), et
    // le premier trouvé fixe la commande. Sans cette sortie, un projet pnpm
    // recevrait aussi `npm install`.
    if (command) break;
  }

  // Après la boucle : ceux-ci ne dépendent d'aucun écosystème.
  for (const path of COMMON_UNTRACKED) {
    if (!copy.includes(path) && (await isUsableUntracked(workspace, path))) copy.push(path);
  }

  if (copy.length === 0 && setup.length === 0) return null;
  return { copy, link: [], setup };
}

/** Existe, n'est pas suivi, et git l'ignore — les trois conditions que `materializeUntracked` exigera. */
async function isUsableUntracked(workspace: string, path: string): Promise<boolean> {
  if (!(await exists(join(workspace, path)))) return false;
  if (await isTracked(workspace, path)) return false;
  return isIgnored(workspace, path);
}

/**
 * Vrai si `path` est sous `prefix` (ou l'est exactement), en segments de
 * chemin — jamais en simple comparaison de chaînes, qui ferait passer
 * `node_modules-old` pour un enfant de `node_modules`.
 *
 * Utilisée pour retirer du diff ce que la matérialisation a posé : un
 * répertoire posé exclut tout ce qu'il contient.
 */
export function isUnderPath(path: string, prefix: string): boolean {
  const normalized = path.split(/[\\/]/).join(sep);
  const base = prefix.split(/[\\/]/).join(sep);
  return normalized === base || normalized.startsWith(base + sep);
}
