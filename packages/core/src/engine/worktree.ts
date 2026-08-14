/**
 * Isolation git : chaque tâche isolée s'exécute dans un worktree jetable, sur
 * une branche dédiée, jamais commitée par le moteur. C'est ce qui rend la
 * règle d'isolation `"auto"` du runner constatable plutôt que déclarative :
 * un agent qui écrit malgré une consigne de lecture seule laisse une trace
 * que `git diff` révèle, contenue hors du dépôt principal.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Change } from "@caesar/protocol";
import { readTask, taskPaths } from "@caesar/protocol";
import type { TaskRecord, TaskStore } from "../store.js";
import { isUnderPath } from "./materialize.js";

const execFileAsync = promisify(execFile);

/** Racine du dépôt git contenant `dir`, ou `null` si `dir` n'est pas dans un dépôt git. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Vrai si le dépôt porte au moins un commit.
 *
 * Un dépôt fraîchement initialisé n'en porte aucun : sa branche n'est pas née et
 * `HEAD` ne désigne rien. `git worktree add … HEAD` y échoue alors sur un
 * `fatal: invalid reference: HEAD` que rien ne rattache à sa cause. Le cas se
 * distingue de « ce n'est pas un dépôt git » — `repoRoot` réussit — et appelle
 * un autre remède : un premier commit.
 */
export async function hasCommits(repo: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

/**
 * Racine du dépôt contenant `dir`, mais **seulement s'il peut réellement
 * accueillir un worktree** — donc `null` aussi bien hors dépôt que dans un
 * dépôt sans le moindre commit.
 *
 * C'est la question que se posent les deux points qui décident de l'isolation
 * (`resolveDelegation` et `prepareIsolation`), et ils se la posaient chacun à
 * leur façon. La composer ici une fois évite qu'ils divergent : un `inplace`
 * refusé tôt puis accepté tard — ou l'inverse — ne serait pas un durcissement
 * mais une incohérence. `prepareIsolation` garde son propre découpage, parce
 * qu'il doit distinguer les deux causes pour en nommer le remède ; ici, seule
 * compte la conclusion.
 */
export async function usableRepoRoot(dir: string): Promise<string | null> {
  const root = await repoRoot(dir);
  if (root === null) return null;
  return (await hasCommits(root)) ? root : null;
}

/**
 * Vrai si git ignore le worktree que la tâche `taskId` va occuper.
 *
 * L'étape 0 du skill `superpowers:using-git-worktrees` — « MUST verify
 * directory is ignored before creating worktree ». `caesar init` inscrit
 * `.caesar/wt/` dans le `.gitignore` et plus personne ne revérifie ; un
 * `.gitignore` réécrit à la main, ou un projet initialisé par une version
 * antérieure, laisse le worktree visible du dépôt principal.
 *
 * La question est posée sur le **chemin exact à créer**, et non sur le
 * répertoire qui le contient : vérifié, un motif terminé par un slash
 * (`.caesar/wt/`, celui que `caesar init` écrit) ne s'applique à `.caesar/wt` qu'à la
 * condition que ce répertoire existe déjà sur le disque — un motif de
 * répertoire ne peut pas s'appliquer à ce que git ne sait pas être un
 * répertoire. Interroger le chemin qu'on s'apprête à occuper évite entièrement
 * la question, et répond à celle qui compte vraiment.
 *
 * `--no-index` pour que la réponse porte sur les règles, indépendamment de ce
 * que l'index contient déjà.
 */
export async function worktreesDirIgnored(repo: string, taskId: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repo, "check-ignore", "-q", "--no-index", "--", join(".caesar", "wt", taskId)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Décrit le décalage entre la racine sur laquelle l'orchestrateur délègue et
 * celle où l'appelant travaille réellement — `null` quand les deux coïncident,
 * ce qui est le cas ordinaire.
 *
 * `caesar mcp install` enregistre `--root <chemin>` une fois pour toutes
 * (`mcp-registration.ts`), et `caesar_delegate` impose ce chemin comme workspace
 * de chaque tâche. Tant que l'agent principal travaille là où l'installation a
 * été faite, tout concorde. Mais qu'il passe lui-même dans un worktree — ce
 * que le skill `superpowers:using-git-worktrees` lui recommande justement de
 * faire — et l'orchestrateur continue de déléguer sur le dépôt d'origine :
 * les sous-agents travaillent dans un arbre que plus personne ne regarde, et
 * leurs diffs s'appliquent à côté de la branche en cours.
 *
 * Comparaison sur la racine du worktree (`repoRoot`), non sur le dépôt commun :
 * deux worktrees d'un même dépôt sont précisément le cas à signaler.
 * Silencieux quand le répertoire courant n'est pas dans un dépôt — il n'y a
 * alors aucune raison de croire qu'il désigne un lieu de travail.
 */
export async function describeWorkspaceMismatch(sessionRoot: string, cwd: string): Promise<string | null> {
  const [here, there] = await Promise.all([repoRoot(cwd), repoRoot(sessionRoot)]);
  if (here === null || there === null || here === there) return null;

  return (
    `L'orchestrateur délègue sur "${sessionRoot}", mais le répertoire de travail courant relève du dépôt "${here}". ` +
    `Les sous-agents travailleront donc dans un arbre différent du vôtre, et leurs modifications n'apparaîtront pas ` +
    `là où vous les attendez. Relancez "caesar mcp install" depuis "${here}", ou lancez "caesar mcp serve --root ${here}".`
  );
}

export interface GitWorktreeEntry {
  path: string;
  /** Nom court de la branche (`caesar/t_…`), absent pour un worktree en HEAD détaché. */
  branch?: string;
}

/**
 * Les worktrees que git connaît réellement pour ce dépôt, chemin **et**
 * branche — `git worktree list --porcelain`, la seule source de vérité sur le
 * sujet.
 *
 * `caesar gc` déduisait la branche d'un worktree orphelin de son nom de
 * répertoire (`caesar/<dirname>`). C'était vrai tant que les deux étaient
 * construits ensemble par `createWorktree` ; ça cesse de l'être dès que le nom
 * de branche gagne la moindre indépendance — et une supposition qui ne tient
 * que par coïncidence finit par laisser des branches derrière elle. Le
 * répertoire, lui, reste listé par git même quand son arborescence a été
 * effacée à la main : `git worktree list` le rapporte avec `prunable`, et
 * c'est aussi ce qui permet de le nettoyer.
 *
 * Le premier worktree rendu par git est toujours le dépôt principal lui-même :
 * l'appelant doit le filtrer, ici par l'emplacement (`.caesar/wt/`).
 */
export async function listGitWorktrees(repo: string): Promise<GitWorktreeEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"]));
  } catch {
    return [];
  }

  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ") && current) {
      // `branch refs/heads/caesar/t_x` → `caesar/t_x`. Un worktree détaché n'a pas
      // cette ligne du tout, d'où le champ optionnel.
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "" && current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  /**
   * Le point de départ du worktree, **résolu en SHA** au moment de sa création
   * — jamais la chaîne symbolique `"HEAD"`.
   *
   * La distinction porte toute la fiabilité du diff : `HEAD` désigne le dernier
   * commit *du worktree*, qui bouge dès que l'agent commite. Un diff contre
   * `HEAD` deviendrait alors vide, `caesar` conclurait « aucun changement » et
   * `caesar apply` n'appliquerait rien — l'effacement silencieux de tout le
   * travail. Un SHA, lui, ne bouge pas.
   *
   * Reste une chaîne libre pour la rétrocompatibilité : `loadWorktreeHandle`
   * relit `task.base_ref` des tâches créées avant ce changement, où `"HEAD"`
   * avait été persisté tel quel.
   */
  baseRef: string;
  /**
   * Chemins que l'orchestrateur a lui-même posés dans le worktree
   * (`[worktree] copy`/`link` — voir `materializeUntracked`), à retirer du
   * diff : ce n'est pas le travail de l'agent, et un `.env` recopié n'a rien
   * à faire dans un `caesar apply`.
   *
   * Porté par le handle plutôt qu'appliqué par le runner, pour que *tout*
   * consommateur du diff en hérite — `caesar diff` et `caesar apply` le
   * recalculent chacun de leur côté, longtemps après la fin de la tâche.
   * Sémantique de préfixe : un répertoire exclu exclut ce qu'il contient.
   */
  excluded?: string[];
}

/**
 * Crée un worktree jetable sous `<root>/.caesar/wt/<taskId>`, sur une nouvelle
 * branche `caesar/<taskId>` partant de `baseRef` (par défaut `HEAD`).
 *
 * `root` doit être la racine du dépôt (typiquement le résultat de
 * `repoRoot(workspace)`) : les commandes git s'y exécutent, et c'est là que
 * vit le répertoire administratif `.caesar/wt`.
 */
/**
 * Nom de branche d'un atelier : `caesar/<rôle ou agent>/<objectif>-<8 car.>`.
 *
 * `caesar/t_3f2a91c0…` est illisible dans un `git branch`, et le devient
 * d'autant plus que la branche cesse d'être un détail d'implémentation : dans
 * un atelier, le sous-agent y commite, et l'utilisateur la relit. Le suffixe
 * porte l'unicité, le reste porte le sens.
 *
 * Le **répertoire**, lui, reste `.caesar/wt/<taskId>` : c'est la clé du store,
 * du bail anti-GC et des chemins de tâche. Les deux ont désormais des noms
 * indépendants — d'où le passage du GC à `git worktree list` pour connaître la
 * branche, plutôt que de la déduire du répertoire.
 *
 * `git check-ref-format` interdit les espaces, `..`, `~^:?*[`, les segments
 * commençant par un point ou finissant par `.lock`, et les slashs consécutifs.
 * Plutôt que d'énumérer les interdits, on n'autorise qu'un alphabet sûr.
 */
export function worktreeBranchName(taskId: string, objective: string, label?: string): string {
  const parts = ["caesar"];
  const scope = slugForBranch(label ?? "");
  if (scope) parts.push(scope);

  const summary = slugForBranch(objective).slice(0, 40).replace(/-+$/, "");
  const suffix = taskId.replace(/^t_/, "").slice(0, 8) || "tache";
  parts.push(summary ? `${summary}-${suffix}` : suffix);
  return parts.join("/");
}

/** Réduit un texte libre à `[a-z0-9-]`, sans tiret en tête ni en queue — toujours acceptable pour `git check-ref-format`. */
function slugForBranch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function createWorktree(
  root: string,
  taskId: string,
  baseRef = "HEAD",
  naming?: { objective: string; label?: string },
): Promise<WorktreeHandle> {
  const branch = naming ? worktreeBranchName(taskId, naming.objective, naming.label) : `caesar/${taskId}`;
  const path = join(root, ".caesar", "wt", taskId);
  await mkdir(join(root, ".caesar", "wt"), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "-b", branch, path, baseRef], { cwd: root });
  // Résolu en SHA plutôt que conservé tel quel : voir `WorktreeHandle.baseRef`.
  // Après `worktree add`, et non avant : c'est bien le commit que le worktree
  // porte réellement qui est enregistré, pas celui que `baseRef` désignait à un
  // instant qui pourrait déjà être dépassé.
  const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"]);
  return { path, branch, baseRef: stdout.trim() };
}

/**
 * Supprime le worktree et sa branche. N'affecte ni l'historique ni les autres
 * branches.
 *
 * Ne détruit pas non plus ce qu'un lien symbolique du worktree désigne dans le
 * dépôt principal — un `node_modules` posé par `[worktree] link`, notamment.
 * Cela ne demande aucune précaution particulière, et c'est vérifié plutôt que
 * supposé (voir les tests de ce module et de `gc.ts`) : supprimer récursivement
 * une arborescence détache les liens qu'elle contient au lieu de les suivre,
 * aussi bien pour `git worktree remove --force` que pour `fs.rm`. Un balayage
 * préventif des liens avant suppression a été envisagé puis écarté : il aurait
 * fait payer à chaque nettoyage le parcours complet du worktree — précisément
 * là où un `node_modules` vient d'être cloné — pour se prémunir d'un risque
 * qui n'existe pas.
 */
export async function removeWorktree(root: string, handle: WorktreeHandle): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", handle.path, "--force"], { cwd: root });
  await execFileAsync("git", ["branch", "-D", handle.branch], { cwd: root });
}

export interface WorktreeDiff {
  files: Change[];
  patch: string;
  isEmpty: boolean;
}

/**
 * Diffe le worktree contre son point de départ — `handle.baseRef`, le SHA figé
 * à la création, **jamais `HEAD`**.
 *
 * Cette fonction diffait contre `HEAD` sous une hypothèse alors vraie : « les
 * agents ne committent pas ». Elle ne l'est plus depuis que le worktree est un
 * atelier où le sous-agent installe, exécute et vérifie — un agent qui y
 * commite déplacerait `HEAD` sur son propre travail, et le diff rendrait vide.
 * `caesar` conclurait « aucun changement », `caesar apply` n'appliquerait rien, et
 * le recoupement qui fonde tout le système disparaîtrait sans un mot. Differ
 * contre le SHA de départ rend le résultat identique que l'agent commite ou
 * non.
 *
 * `add -A --intent-to-add` reste nécessaire pour le cas inverse, celui de
 * l'agent qui ne commite pas : un fichier créé est invisible pour git tant
 * qu'il n'est ni indexé ni commité. Cette commande enregistre son existence
 * sans indexer son contenu, ce qui suffit à le faire apparaître dans le diff.
 * C'est acceptable ici précisément parce que le worktree est jetable : on ne
 * pollue l'index d'aucun dépôt qui compte.
 */
export async function diffWorktree(handle: WorktreeHandle): Promise<WorktreeDiff> {
  await execFileAsync("git", ["-C", handle.path, "add", "-A", "--intent-to-add"]);
  const [{ stdout: nameStatus }, { stdout: patch }] = await Promise.all([
    execFileAsync("git", ["-C", handle.path, "diff", "--name-status", handle.baseRef]),
    execFileAsync("git", ["-C", handle.path, "diff", handle.baseRef]),
  ]);
  const files = excludeMaterialized(parseNameStatus(nameStatus), handle.excluded);
  return { files, patch, isEmpty: files.length === 0 };
}

/**
 * Retire du diff ce que la matérialisation a posé — voir `WorktreeHandle.excluded`.
 *
 * Seule la liste des fichiers est filtrée, pas `patch` : le patch est le texte
 * que produit git, et le refabriquer par découpage serait fragile là où il
 * doit rester exact. En pratique, un chemin matérialisé est ignoré par git
 * (`materializeUntracked` refuse d'en poser un qui ne le serait pas), donc il
 * n'apparaît dans aucun des deux — ce filtrage est le garde-fou du cas où
 * cette invariance viendrait à être prise en défaut, pas le mécanisme
 * ordinaire.
 */
function excludeMaterialized(files: Change[], excluded: readonly string[] | undefined): Change[] {
  if (!excluded || excluded.length === 0) return files;
  return files.filter((change) => !excluded.some((prefix) => isUnderPath(change.path, prefix)));
}

/**
 * Empreinte sha256 (hex) du texte d'un patch — calculée au même endroit des
 * deux côtés qui doivent la comparer : à l'application (ci-dessous) et au
 * ramasse-miettes (`gc.ts`), qui recalcule le patch par le même
 * `diffWorktree` pour décider si le worktree a bougé depuis.
 */
export function patchDigest(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

export type RecordedApplyOutcome = "applied" | "conflicts" | "no_worktree";

export interface RecordedApplyResult {
  outcome: RecordedApplyOutcome;
  conflicts: string[];
  /** Vrai quand il n'y avait rien à appliquer (pas de worktree, ou diff vide) : rien n'est enregistré. */
  isEmpty: boolean;
}

/**
 * Le seul chemin d'application : diffe le worktree, applique le patch au
 * dépôt principal, puis inscrit le fait dans l'enregistrement de la tâche —
 * `applied_at` et l'empreinte du patch appliqué. Rien n'est inscrit sur un
 * diff vide ni sur un conflit : l'enregistrement ne témoigne que d'une
 * application réellement advenue, et un nouvel apply réussi l'écrase (la
 * dernière application fait foi). Sans cette trace, `caesar gc` ne pouvait
 * pas distinguer un worktree intégré d'un worktree porteur de travail
 * unique : il refusait les deux, même après un cycle parfaitement
 * discipliné (constaté sur deux tâches du projet `support`, 2026-08-12).
 */
export async function applyRecordedWorktree(root: string, store: TaskStore, record: TaskRecord): Promise<RecordedApplyResult> {
  const handle = await loadWorktreeHandle(record);
  if (!handle) return { outcome: "no_worktree", conflicts: [], isEmpty: true };

  const diff = await diffWorktree(handle);
  if (diff.isEmpty) return { outcome: "applied", conflicts: [], isEmpty: true };

  const result = await applyPatch(root, diff.patch);
  if (!result.applied) return { outcome: "conflicts", conflicts: result.conflicts, isEmpty: false };

  await store.update(record.id, {
    applied_at: new Date().toISOString(),
    applied_patch_digest: patchDigest(diff.patch),
  });
  return { outcome: "applied", conflicts: [], isEmpty: false };
}

/**
 * Applique un patch au dépôt principal par `git apply --3way`,
 * sans toucher aux branches ni à l'historique : réversible, sans effet de
 * bord sur l'historique de l'utilisateur. N'appelle jamais `git commit`.
 *
 * En cas d'échec (conflit), renvoie la liste des fichiers en conflit plutôt
 * que de lever — cette liste vient de `git diff --diff-filter=U`, donc de
 * l'état réel de l'index après la tentative, pas d'un décodage fragile des
 * messages humains de `git apply`.
 */
async function applyPatch(root: string, patch: string): Promise<{ applied: boolean; conflicts: string[] }> {
  const scratchDir = await mkdtemp(join(tmpdir(), "caesar-patch-"));
  const patchFile = join(scratchDir, "worktree.patch");
  try {
    await writeFile(patchFile, patch, "utf8");
    try {
      await execFileAsync("git", ["apply", "--3way", patchFile], { cwd: root });
      return { applied: true, conflicts: [] };
    } catch {
      const { stdout } = await execFileAsync("git", ["-C", root, "diff", "--name-only", "--diff-filter=U"]);
      const conflicts = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      return { applied: false, conflicts };
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Capture l'état git du workspace réel (`git status --porcelain`), pour le
 * comparer avant/après une exécution en isolation `"inplace"` — voir C2/C3
 * de la revue finale : `git diff` ne faisait foi qu'en isolation `worktree`,
 * jamais `inplace`, où aucun recoupement n'avait lieu et où une écriture par
 * un agent en lecture seule n'était ni contenue, ni détectée.
 *
 * Le répertoire administratif `.caesar/` (tâches, état, worktrees) est exclu
 * du pathspec : contrairement au worktree jetable — dont l'arborescence ne
 * contient structurellement jamais `.caesar/tasks/<id>` (racine distincte,
 * `deps.root` plutôt que `workspace`) — le workspace réel EST `deps.root`
 * pour une tâche `inplace`, et `.caesar/tasks/<id>` y est donc physiquement
 * créé par l'orchestrateur lui-même pendant l'exécution. Sans cette
 * exclusion, la simple existence du répertoire de tâche ferait croire à une
 * écriture de l'agent sur toute tâche `inplace`, quel que soit son
 * comportement réel — un faux positif systématique bien pire que le faux
 * négatif, rare, d'un agent qui modifierait `.caesar/config.toml` lui-même
 * (alors masqué par cette même exclusion, tout `.caesar/` étant écarté en bloc
 * : `git status` réduit un répertoire entièrement non suivi à une seule
 * ligne `?? .caesar/`, qui rend inopérant tout pathspec d'exclusion plus fin
 * que `.caesar` entier — vérifié empiriquement).
 *
 * Jamais de `git add` ici, à la différence de `diffWorktree` : le workspace
 * n'est pas jetable, et modifier l'index réel de l'utilisateur pour une
 * simple observation serait un effet de bord que l'isolation `"inplace"` ne
 * promet pas. `null` si `workspace` n'est pas un dépôt git (ou toute autre
 * erreur) : jamais une exception, cette capture est un filet, pas une
 * exigence.
 */
export async function captureWorkspaceStatus(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspace, "status", "--porcelain", "--", ".", ":(exclude).caesar"]);
    return stdout;
  } catch {
    return null;
  }
}

/** `git status --porcelain` d'un chemin vers son code à deux lettres (`XY`, voir `git help status`). */
function parsePorcelainStatus(status: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    // "R  ancien -> nouveau" pour un renommage : seul le chemin final nous intéresse ici.
    const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
    map.set(path.trim(), code);
  }
  return map;
}

function porcelainCodeToAction(code: string): Change["action"] | undefined {
  const x = code[0];
  const y = code[1];
  if (x === "?" || x === "A" || y === "A") return "created";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "M" || y === "M" || x === "U" || y === "U") return "modified";
  return undefined;
}

/**
 * Diffe deux instantanés `git status --porcelain` du même workspace, avant
 * et après une exécution. Contrairement à `diffWorktree`, ne rend jamais de
 * patch (`patch: ""`) : sans `git add`, seule la liste des chemins touchés
 * est fiable à reconstituer depuis `git status`, pas le contenu du diff.
 */
export async function diffWorkspaceStatus(workspace: string, before: string): Promise<WorktreeDiff> {
  const after = await captureWorkspaceStatus(workspace);
  if (after === null) return { files: [], patch: "", isEmpty: true };

  const beforeMap = parsePorcelainStatus(before);
  const afterMap = parsePorcelainStatus(after);
  const files: Change[] = [];
  for (const [path, code] of afterMap) {
    if (beforeMap.get(path) === code) continue;
    const action = porcelainCodeToAction(code);
    if (action) files.push({ path, action, summary: "" });
  }
  return { files, patch: "", isEmpty: files.length === 0 };
}

/**
 * Reconstruit le `WorktreeHandle` d'une tâche à partir de son enregistrement
 * (`TaskRecord`) — `null` si la tâche n'a pas tourné en isolation worktree.
 * Partagé par `caesar diff`/`caesar apply` (CLI) et `caesar_diff`/`caesar_apply`
 * (serveur MCP), qui en avaient chacun leur propre copie avant la revue de
 * la tâche 7 : voir son rapport de correction.
 */
export async function loadWorktreeHandle(record: TaskRecord): Promise<WorktreeHandle | null> {
  if (record.isolation !== "worktree" || !record.branch) return null;
  const task = await readTask(taskPaths(record.task_dir));
  return {
    path: record.workspace,
    branch: record.branch,
    baseRef: task.base_ref ?? "HEAD",
    // Restitué au handle pour que `caesar diff` et `caesar apply`, qui recalculent
    // le diff bien après la fin de la tâche, excluent ce que l'orchestrateur
    // avait posé — sans quoi un `.env` recopié redeviendrait applicable.
    ...(record.excluded_paths ? { excluded: record.excluded_paths } : {}),
  };
}

/** Traduit `git diff --name-status` vers le vocabulaire commun `Change`. */
function parseNameStatus(raw: string): Change[] {
  const changes: Change[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split("\t");
    if (!code) continue;

    if (code.startsWith("R")) {
      const [oldPath, newPath] = rest;
      if (newPath) {
        changes.push({ path: newPath, action: "renamed", summary: oldPath ? `renommé depuis ${oldPath}` : "" });
      }
      continue;
    }

    const path = rest[0];
    if (!path) continue;
    const action = code === "A" ? "created" : code === "M" ? "modified" : code === "D" ? "deleted" : undefined;
    if (action) changes.push({ path, action, summary: "" });
  }
  return changes;
}
