# Cycle apply → gc : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** `orch apply` inscrit le fait de l'application dans l'enregistrement de la tâche, `orch gc` collecte les worktrees appliqués et inchangés depuis, et les assets déposés disent comment invoquer le binaire et boucler le cycle.

**Architecture :** un helper unique dans `@orch/core` (`applyRecordedWorktree`) remplace `applyWorktree` comme seul chemin d'application et pose `applied_at` + `applied_patch_digest` (sha256 du patch) sur le `TaskRecord` ; `garbageCollectWorktrees` recharge le vrai handle, recalcule le patch par le même `diffWorktree`, et supprime sur empreinte conforme (nouvelle raison `applied`). Les deux façades (CLI, MCP) se réduisent au helper. Les sources d'assets de ce dépôt sont éditées puis resynchronisées dans le catalogue généré.

**Tech stack :** monorepo pnpm + TypeScript (Node 24), zod, vitest, git. Spec : `docs/superpowers/specs/2026-08-12-apply-gc-cycle-design.md`.

## Global Constraints

- Commentaires et docstrings du code : en **français**, denses en « pourquoi », comme le reste du dépôt.
- Contenu des assets (`.claude/skills/orch/**`) : en **anglais** (langue des assets existants).
- Messages de commit : en français, style du dépôt (« Pose… », « Fait… », verbe au présent), terminés par `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `packages/core/src/agent-assets.generated.ts` ne s'édite **jamais** à la main : `pnpm run assets:sync` le régénère. Ne pas lancer `orch init` dans ce dépôt pendant l'édition des sources d'assets (il écraserait les éditions non synchronisées).
- Les schémas zod du store ne sont pas `.strict()` : tout ajout de champ est optionnel et rétrocompatible dans les deux sens.
- Tests : `pnpm vitest run <chemin>` depuis la racine du dépôt. Build : `pnpm build` (tsc -b). Ne jamais committer `dist/` ni `dist-bin/`.
- Chaque tâche du plan se termine par un commit qui ne mélange rien d'autre.

---

### Task 1 : Champs `applied_at` et `applied_patch_digest` sur `TaskRecord`

**Files:**
- Modify: `packages/core/src/store.ts` (interface `TaskRecord` ~ligne 85, schéma `TaskRecordSchema` ~ligne 161)
- Test: `packages/core/src/store.test.ts`

**Interfaces:**
- Consumes: rien de nouveau.
- Produces: `TaskRecord.applied_at?: string` (ISO) et `TaskRecord.applied_patch_digest?: string` (sha256 hex, 64 caractères) — écrits par la Task 2, lus par la Task 3.

- [ ] **Step 1 : Écrire le test qui échoue**

Dans `packages/core/src/store.test.ts`, à l'intérieur du `describe("fileTaskStore")` existant (réutiliser la variable `root` posée par son `beforeEach` ; s'inspirer du premier test `create`/`get` du fichier pour la forme du record) :

```ts
it("persiste et relit les champs d'application (applied_at, applied_patch_digest)", async () => {
  const store = fileTaskStore(root);
  const record: TaskRecord = {
    id: "t_applique",
    agent: "codex",
    objective: "persister les champs d'application",
    status: "succeeded",
    created_at: "2026-08-12T09:00:00.000Z",
    task_dir: join(root, ".orch", "tasks", "t_applique"),
    workspace: join(root, "ws"),
    isolation: "worktree",
    mode: "write",
    report_via: "file",
    depth: 0,
  };
  await store.create(record);
  await store.update("t_applique", {
    applied_at: "2026-08-12T10:00:00.000Z",
    applied_patch_digest: "a".repeat(64),
  });

  const relu = await store.get("t_applique");
  expect(relu?.applied_at).toBe("2026-08-12T10:00:00.000Z");
  expect(relu?.applied_patch_digest).toBe("a".repeat(64));
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run : `pnpm vitest run packages/core/src/store.test.ts`
Attendu : FAIL — erreur TypeScript (`applied_at` n'existe pas sur `Partial<TaskRecord>`), ou `relu?.applied_at` vaut `undefined` (le schéma de relecture ignore le champ inconnu ? non : sans `.strict()` zod laisse passer — l'échec attendu est donc l'erreur de type à la compilation du test).

- [ ] **Step 3 : Implémenter**

Dans `packages/core/src/store.ts`, à la fin de l'interface `TaskRecord` (après `pid?: number;`) :

```ts
  /**
   * Posés par `applyRecordedWorktree` (engine/worktree.ts) quand le diff du
   * worktree a été appliqué au dépôt principal : l'instant de l'application,
   * et le sha256 (hex) du texte du patch appliqué. Un nouvel apply réussi
   * les écrase — c'est la dernière application qui fait foi. `orch gc` s'en
   * sert pour collecter un worktree dont le patch courant porte encore la
   * même empreinte : un fait daté et positif, jamais une déduction depuis le
   * contenu. Absents pour toute tâche jamais appliquée, appliquée à vide, ou
   * antérieure à ce mécanisme — le schéma n'étant pas `.strict()`, l'ajout
   * est rétrocompatible dans les deux sens.
   */
  applied_at?: string;
  applied_patch_digest?: string;
```

Dans `TaskRecordSchema`, après `pid: z.number().int().positive().optional(),` :

```ts
  applied_at: z.string().optional(),
  applied_patch_digest: z.string().optional(),
```

- [ ] **Step 4 : Vérifier le passage**

Run : `pnpm vitest run packages/core/src/store.test.ts`
Attendu : PASS (tous les tests du fichier).

- [ ] **Step 5 : Commit**

```bash
git add packages/core/src/store.ts packages/core/src/store.test.ts
git commit -m "Donne au store la mémoire d'une application : applied_at + empreinte

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2 : `applyRecordedWorktree`, seul chemin d'application (core)

**Files:**
- Modify: `packages/core/src/engine/worktree.ts` (remplace `applyWorktree`, ~lignes 344-376)
- Test: `packages/core/src/engine/worktree.test.ts`

**Interfaces:**
- Consumes: `TaskRecord.applied_at`/`applied_patch_digest` (Task 1), `loadWorktreeHandle(record)`, `diffWorktree(handle)`, `TaskStore.update` existants.
- Produces (utilisés par les Tasks 3, 4) :

```ts
export function patchDigest(patch: string): string; // sha256 hex du texte du patch
export type RecordedApplyOutcome = "applied" | "conflicts" | "no_worktree";
export interface RecordedApplyResult {
  outcome: RecordedApplyOutcome;
  conflicts: string[];
  isEmpty: boolean; // vrai quand il n'y avait rien à appliquer : rien n'est enregistré
}
export function applyRecordedWorktree(root: string, store: TaskStore, record: TaskRecord): Promise<RecordedApplyResult>;
```

`applyWorktree` **disparaît** (ses deux seuls appelants, les façades CLI et MCP, migrent en Task 4 — entre les deux tâches, le build racine est cassé : c'est attendu, ne pas « réparer » en le réintroduisant ; enchaîner Task 4 avant tout `pnpm build` global).

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `packages/core/src/engine/worktree.test.ts`, ajouter un `describe` autonome. Réutiliser les helpers locaux du fichier s'ils existent (`initRepo`, `git`) ; sinon recopier ceux de `packages/core/src/engine/gc.test.ts` (lignes 21-33). Imports à ajouter : `applyRecordedWorktree`, `createWorktree`, `diffWorktree`, `loadWorktreeHandle`, `patchDigest` depuis `./worktree.js` ; `fileTaskStore` et le type `TaskRecord` depuis `../store.js` ; `TASK_PROTOCOL`, `TaskSchema`, `taskPaths`, `writeTask` depuis `@orch/protocol` ; `mkdtemp`, `readFile`, `rm`, `writeFile` de `node:fs/promises`.

```ts
describe("applyRecordedWorktree", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-apply-record-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Une tâche worktree enregistrée, avec le task.json que relira loadWorktreeHandle. */
  async function recordedTask(id: string): Promise<TaskRecord> {
    const handle = await createWorktree(root, id);
    const record: TaskRecord = {
      id,
      agent: "codex",
      objective: "appliquer et enregistrer",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      ended_at: "2026-08-12T09:01:00.000Z",
      task_dir: join(root, ".orch", "tasks", id),
      workspace: handle.path,
      isolation: "worktree",
      mode: "write",
      branch: handle.branch,
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);
    const paths = taskPaths(record.task_dir);
    await writeTask(paths, TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id,
      created_at: record.created_at,
      agent: record.agent,
      objective: record.objective,
      mode: "write",
      isolation: "worktree",
      workspace: handle.path,
      base_ref: handle.baseRef,
      deadline_ms: 60_000,
      report_path: paths.reportPath,
      events_path: paths.eventsPath,
    }));
    return record;
  }

  it("applique le patch et inscrit applied_at + empreinte dans l'enregistrement", async () => {
    const record = await recordedTask("t_enregistre");
    await writeFile(join(record.workspace, "b.txt"), "travail\n", "utf8");

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "applied", conflicts: [], isEmpty: false });
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("travail\n");
    const relu = await fileTaskStore(root).get(record.id);
    expect(relu?.applied_at).toBeDefined();
    const handle = await loadWorktreeHandle(relu!);
    expect(relu?.applied_patch_digest).toBe(patchDigest((await diffWorktree(handle!)).patch));
  });

  it("diff vide : outcome applied mais rien d'appliqué, rien d'enregistré", async () => {
    const record = await recordedTask("t_vide");

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "applied", conflicts: [], isEmpty: true });
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });

  it("conflit : fichiers nommés, rien d'enregistré", async () => {
    const record = await recordedTask("t_conflit");
    await writeFile(join(record.workspace, "a.txt"), "version worktree\n", "utf8");
    await writeFile(join(root, "a.txt"), "version workspace divergente\n", "utf8");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-q", "-m", "divergence"]);

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result.outcome).toBe("conflicts");
    expect(result.conflicts).toContain("a.txt");
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });

  it("tâche sans worktree (inplace) : no_worktree, rien d'enregistré", async () => {
    const record: TaskRecord = {
      id: "t_inplace",
      agent: "codex",
      objective: "tâche sur place",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      task_dir: join(root, ".orch", "tasks", "t_inplace"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "no_worktree", conflicts: [], isEmpty: true });
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run : `pnpm vitest run packages/core/src/engine/worktree.test.ts`
Attendu : FAIL — `applyRecordedWorktree` et `patchDigest` ne sont pas exportés.

- [ ] **Step 3 : Implémenter**

Dans `packages/core/src/engine/worktree.ts` :

1. Ajouter aux imports : `import { createHash } from "node:crypto";` et compléter l'import store existant : `import type { TaskRecord, TaskStore } from "../store.js";`.

2. Juste au-dessus de l'actuel `applyWorktree`, ajouter :

```ts
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
 * dernière application fait foi). Sans cette trace, `orch gc` ne pouvait
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
```

3. Remplacer `applyWorktree` (export supprimé) par la fonction privée `applyPatch`, en conservant la docstring existante adaptée (le « Applique le patch du worktree au dépôt principal par `git apply --3way`… réversible… N'appelle jamais `git commit`… liste des conflits par `--diff-filter=U` ») :

```ts
async function applyPatch(root: string, patch: string): Promise<{ applied: boolean; conflicts: string[] }> {
  const scratchDir = await mkdtemp(join(tmpdir(), "orch-patch-"));
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
```

- [ ] **Step 4 : Vérifier le passage**

Run : `pnpm vitest run packages/core/src/engine/worktree.test.ts`
Attendu : PASS. (Le build racine reste cassé tant que la Task 4 n'a pas migré les façades — normal.)

- [ ] **Step 5 : Commit**

```bash
git add packages/core/src/engine/worktree.ts packages/core/src/engine/worktree.test.ts
git commit -m "Fait de l'application un fait enregistré : applyRecordedWorktree

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3 : `gc` collecte les worktrees appliqués et inchangés (core)

**Files:**
- Modify: `packages/core/src/engine/gc.ts`
- Test: `packages/core/src/engine/gc.test.ts`

**Interfaces:**
- Consumes: `applyRecordedWorktree`, `patchDigest`, `diffWorktree`, `loadWorktreeHandle` (Task 2) ; `TaskRecord.applied_at`/`applied_patch_digest` (Task 1).
- Produces: `WorktreeGcReason` gagne `"applied"` ; `WorktreeGcEntry` gagne `applied_at?: string` — consommés par la Task 5 (libellés CLI) et exposés tels quels dans `orch gc --json`.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `packages/core/src/engine/gc.test.ts`, à l'intérieur du `describe("garbageCollectWorktrees")` (réutiliser `root`, `git`, `pathExists`, `createRecordedWorktree`). Compléter les imports : `TASK_PROTOCOL`, `TaskSchema`, `writeTask` s'ajoutent aux imports `@orch/protocol` existants ; `applyRecordedWorktree` s'ajoute à l'import `./worktree.js`.

```ts
  /** Une tâche terminée dont le travail a été appliqué par le chemin officiel. */
  async function appliedRecordedWorktree(id: string): Promise<TaskRecord> {
    const record = await createRecordedWorktree(id, "succeeded");
    await writeFile(join(record.workspace, `${id}.txt`), "travail\n", "utf8");
    const paths = taskPaths(record.task_dir);
    const baseRef = (await git(record.workspace, ["rev-parse", "HEAD"])).trim();
    await writeTask(paths, TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id,
      created_at: record.created_at,
      agent: record.agent,
      objective: record.objective,
      mode: "write",
      isolation: "worktree",
      workspace: record.workspace,
      base_ref: baseRef,
      deadline_ms: 60_000,
      report_path: paths.reportPath,
      events_path: paths.eventsPath,
    }));
    const applied = await applyRecordedWorktree(root, fileTaskStore(root), record);
    expect(applied.outcome).toBe("applied");
    return (await fileTaskStore(root).get(id))!;
  }

  it("supprime le worktree d'une tâche appliquée dont rien n'a bougé depuis", async () => {
    const record = await appliedRecordedWorktree("t_appliquee");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "applied", applied_at: record.applied_at }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await git(root, ["branch", "--list", record.branch!])).trim()).toBe("");
  });

  it("--dry-run annonce la collecte d'une tâche appliquée sans supprimer ni réécrire", async () => {
    const record = await appliedRecordedWorktree("t_appliquee_dry");

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "would_remove", reason: "applied" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect((await fileTaskStore(root).get(record.id))?.applied_patch_digest).toBe(record.applied_patch_digest);
  });

  it("conserve un worktree modifié depuis son application, applied_at exposé", async () => {
    const record = await appliedRecordedWorktree("t_retouchee");
    await writeFile(join(record.workspace, "t_retouchee.txt"), "retouche postérieure à l'application\n", "utf8");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified", applied_at: record.applied_at }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
  });

  it("vérification impossible (task.json disparu) : conservé, jamais supprimé sur un doute", async () => {
    const record = await appliedRecordedWorktree("t_sans_task_json");
    await rm(taskPaths(record.task_dir).taskFile, { force: true });

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
  });
```

- [ ] **Step 2 : Vérifier l'échec**

Run : `pnpm vitest run packages/core/src/engine/gc.test.ts`
Attendu : FAIL — les quatre nouveaux tests (raison `"applied"` inconnue, worktrees appliqués conservés au lieu d'être supprimés).

- [ ] **Step 3 : Implémenter**

Dans `packages/core/src/engine/gc.ts` :

1. Étendre l'import worktree existant : `import { diffWorktree, listGitWorktrees, loadWorktreeHandle, patchDigest, removeWorktree, repoRoot } from "./worktree.js";`.

2. `export type WorktreeGcReason = "clean" | "modified" | "applied" | "active" | "inspection_failed";`

3. Dans `WorktreeGcEntry`, après `status?: TaskStatus;` :

```ts
  /**
   * L'instant de la dernière application (`orch apply`) porté par
   * l'enregistrement, restitué tel quel : c'est lui qui distingue, parmi les
   * conservés `modified`, ceux qui ont été appliqués puis retouchés.
   */
  applied_at?: string;
```

4. Dans `Candidate`, ajouter `record?: TaskRecord;` et le renseigner dans `recordedCandidates` (`record,` à côté de `id: record.id`). Les orphelins n'en ont pas.

5. Ajouter la fonction privée, au-dessus de `garbageCollectWorktrees` :

```ts
/**
 * Le worktree d'une tâche appliquée porte-t-il exactement ce qui a été
 * appliqué ? Vrai seulement quand l'enregistrement témoigne d'une
 * application (`applied_at` + empreinte) et que le patch recalculé — par le
 * même `diffWorktree` que l'application, seule façon de rendre les
 * empreintes comparables — porte encore la même empreinte. Tout échec de la
 * vérification (task.json disparu, git en échec) répond non : on ne
 * supprime jamais sur un doute.
 *
 * `diffWorktree` pose un `add --intent-to-add` dans l'index du worktree
 * candidat, y compris en `--dry-run` : c'est l'index d'un worktree jetable,
 * déjà traversé par l'application elle-même, et le geste est nécessaire —
 * sans lui, les fichiers non suivis manqueraient au patch et l'empreinte ne
 * correspondrait jamais. Le workspace réel et le store, eux, restent
 * intouchés en `--dry-run`.
 */
async function appliedAndUnchanged(record: TaskRecord | undefined): Promise<boolean> {
  if (!record?.applied_at || !record.applied_patch_digest) return false;
  try {
    const handle = await loadWorktreeHandle(record);
    if (!handle) return false;
    const diff = await diffWorktree(handle);
    return patchDigest(diff.patch) === record.applied_patch_digest;
  } catch {
    return false;
  }
}
```

6. Dans la boucle de `garbageCollectWorktrees` : enrichir `common` —

```ts
    const common = {
      id: candidate.id,
      path: candidate.handle.path,
      branch: candidate.handle.branch,
      orphan: candidate.orphan,
      status: candidate.status,
      ...(candidate.record?.applied_at ? { applied_at: candidate.record.applied_at } : {}),
    };
```

puis remplacer le bloc final (de `if (modified && !options.force) {` jusqu'au `entries.push({ ...common, action, reason: modified ? "modified" : "clean" });` inclus) par :

```ts
    let reason: WorktreeGcReason = "clean";
    if (modified) {
      if (await appliedAndUnchanged(candidate.record)) {
        // Le patch courant est celui qui a été appliqué : le worktree ne
        // porte plus rien d'unique, il est collectable comme un propre.
        reason = "applied";
      } else if (!options.force) {
        entries.push({ ...common, action: "kept", reason: "modified" });
        continue;
      } else {
        reason = "modified";
      }
    }

    const action: WorktreeGcAction = options.dryRun ? "would_remove" : "removed";
    if (!options.dryRun) {
      try {
        await removeWorktree(repo, candidate.handle);
      } catch (error) {
        // Un résidu que git ne connaît pas (création interrompue avant son
        // enregistrement) : le dire, plutôt que de faire échouer tout le
        // nettoyage sur un répertoire que git refuse de reprendre en main.
        entries.push({
          ...common,
          action: "kept",
          reason: "inspection_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    entries.push({ ...common, action, reason });
```

7. Mettre à jour la docstring d'en-tête du module : « une tâche terminée n'est supprimée que si son worktree est propre **ou si son patch a été appliqué et n'a pas bougé depuis (`applied_at` + empreinte, posés par `applyRecordedWorktree`)**, sauf demande explicite avec `force` ».

- [ ] **Step 4 : Vérifier le passage**

Run : `pnpm vitest run packages/core/src/engine/gc.test.ts`
Attendu : PASS — les quatre nouveaux tests et tous les existants.

- [ ] **Step 5 : Commit**

```bash
git add packages/core/src/engine/gc.ts packages/core/src/engine/gc.test.ts
git commit -m "Apprend au gc à collecter les worktrees appliqués et inchangés

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4 : Les façades apply (CLI et MCP) se réduisent au helper

**Files:**
- Modify: `packages/cli/src/commands/tasks.ts` (`runApply`, ~lignes 374-401, et l'import `@orch/core` en tête)
- Modify: `packages/mcp-server/src/tools/apply.ts`
- Test: `packages/cli/src/commands/tasks.test.ts`, `packages/mcp-server/src/tools/apply.test.ts`

**Interfaces:**
- Consumes: `applyRecordedWorktree` et `RecordedApplyResult` (Task 2).
- Produces: sorties CLI/MCP inchangées pour l'utilisateur (mêmes messages, mêmes codes de sortie, même JSON) — seule addition : l'enregistrement porte désormais les champs d'application.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `packages/mcp-server/src/tools/apply.test.ts` : dans le test existant « applique au dépôt principal le diff d'une tâche isolée en worktree », après l'assertion sur le contenu de `nouveau.txt`, ajouter :

```ts
        const record = await session.store.get(taskId);
        expect(record?.applied_at).toBeDefined();
        expect(record?.applied_patch_digest).toMatch(/^[0-9a-f]{64}$/);
```

et dans le test « isolation inplace : rien à appliquer, applied: true », ajouter à la fin :

```ts
        const record = await session.store.get(taskId);
        expect(record?.applied_at).toBeUndefined();
```

Dans `packages/cli/src/commands/tasks.test.ts` : localiser le test existant qui exerce `runApply` avec succès (dans le `describe` « orch logs / cancel / diff / apply — sur un store peuplé par de vraies tâches », ~ligne 129 ; chercher `runApply`). Après l'assertion de succès existante, ajouter les mêmes trois lignes d'assertion sur le record (via `fileTaskStore(root).get(<id du test>)` — reprendre la variable d'identifiant du test).

- [ ] **Step 2 : Vérifier l'échec**

Run : `pnpm vitest run packages/mcp-server/src/tools/apply.test.ts packages/cli/src/commands/tasks.test.ts`
Attendu : FAIL — `applied_at` vaut `undefined` après apply (les façades appellent encore l'ancien chemin, qui n'existe d'ailleurs plus : erreur de compilation sur `applyWorktree`).

- [ ] **Step 3 : Implémenter**

`packages/mcp-server/src/tools/apply.ts` — remplacer l'import core par `import { applyRecordedWorktree } from "@orch/core";` et le corps de `orchApply` par :

```ts
export async function orchApply(session: McpSession, input: OrchApplyInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Tâche inconnue : "${input.task_id}".`);

  const result = await applyRecordedWorktree(session.root, session.store, record);
  if (result.outcome === "conflicts") {
    return jsonResult({ task_id: input.task_id, applied: false, conflicts: result.conflicts });
  }
  // "no_worktree" reste applied: true — le contrat existant de l'outil pour
  // les tâches inplace ou sans changement, décrit dans sa description.
  return jsonResult({ task_id: input.task_id, applied: true, conflicts: [] });
}
```

`packages/cli/src/commands/tasks.ts` — dans l'import `@orch/core`, remplacer `applyWorktree` par `applyRecordedWorktree` (et retirer `loadWorktreeHandle` s'il n'est plus utilisé que par `runDiff` — vérifier : `runDiff` s'en sert, le garder). Corps de `runApply` :

```ts
export async function runApply(root: string, id: string, options: ApplyOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Tâche inconnue : "${id}".`);
    return EXIT_USAGE;
  }

  const result = await applyRecordedWorktree(root, store, record);
  if (result.outcome === "no_worktree") {
    const message = `Tâche "${id}" : isolation "${record.isolation}", rien à appliquer.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: [], message });
    else writeLine(io.stdout, message);
    return EXIT_OK;
  }

  if (result.outcome === "conflicts") {
    const message = `Conflits en appliquant la tâche "${id}" : ${result.conflicts.join(", ")}.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: result.conflicts });
    else printError(io, message);
    return EXIT_RUNTIME;
  }

  if (options.json) printJson(io, { id, applied: true, conflicts: [] });
  else writeLine(io.stdout, `Tâche "${id}" appliquée au dépôt principal.`);
  return EXIT_OK;
}
```

- [ ] **Step 4 : Vérifier le passage et le build**

Run : `pnpm vitest run packages/mcp-server/src/tools/apply.test.ts packages/cli/src/commands/tasks.test.ts && pnpm build`
Attendu : PASS et build racine vert (plus aucune référence à `applyWorktree`).

- [ ] **Step 5 : Commit**

```bash
git add packages/mcp-server/src/tools/apply.ts packages/mcp-server/src/tools/apply.test.ts packages/cli/src/commands/tasks.ts packages/cli/src/commands/tasks.test.ts
git commit -m "Réduit les deux façades apply au chemin enregistré du core

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5 : Libellés et conseils du gc CLI

**Files:**
- Modify: `packages/cli/src/commands/gc.ts` (`reasonLabel` ligne 39, `keptAdvice` ligne 60)
- Test: `packages/cli/src/commands/gc.test.ts`

**Interfaces:**
- Consumes: `WorktreeGcEntry.applied_at`, raison `"applied"` (Task 3).
- Produces: rien de nouveau pour les autres tâches — sorties humaines uniquement. Le JSON expose déjà `applied_at` et la raison via la sérialisation directe des entrées.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `packages/cli/src/commands/gc.test.ts` : reprendre les helpers du fichier (setup de dépôt, store peuplé, `Io` de capture — mirror du test existant qui vérifie le libellé « modifications non intégrées »). Ajouter deux tests ; pour fabriquer une tâche appliquée, reprendre le helper `appliedRecordedWorktree` de `packages/core/src/engine/gc.test.ts` (mêmes imports `@orch/protocol` et `@orch/core` — `applyRecordedWorktree`, `TaskSchema`, `TASK_PROTOCOL`, `writeTask`, `taskPaths`) :

```ts
  it("étiquette « appliqué » un worktree collecté après application", async () => {
    await appliedRecordedWorktree("t_appliquee_cli");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(stdout()).toContain("supprimé");
    expect(stdout()).toContain("appliqué au workspace, rien de nouveau depuis");
  });

  it("étiquette « modifié depuis son application » un worktree retouché après apply, avec le conseil adapté", async () => {
    const record = await appliedRecordedWorktree("t_retouchee_cli");
    await writeFile(join(record.workspace, "t_retouchee_cli.txt"), "retouche\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(stdout()).toContain("modifié depuis son application");
    expect(stdout()).toContain("pour voir ce qui a bougé depuis l'application");
  });
```

(`stdout()`/`io` : reprendre le mécanisme de capture des tests existants du fichier ; ne pas en inventer un second.)

- [ ] **Step 2 : Vérifier l'échec**

Run : `pnpm vitest run packages/cli/src/commands/gc.test.ts`
Attendu : FAIL — `reasonLabel` ne connaît pas `"applied"` (retour `undefined` dans la cellule) et le conseil adapté n'existe pas.

- [ ] **Step 3 : Implémenter**

Dans `packages/cli/src/commands/gc.ts` :

```ts
function reasonLabel(entry: WorktreeGcEntry): string {
  switch (entry.reason) {
    case "clean":
      return entry.orphan ? "orphelin, aucune modification" : "tâche terminée, aucune modification";
    case "applied":
      return "appliqué au workspace, rien de nouveau depuis";
    case "modified":
      if (entry.action !== "kept") return "modifications non intégrées, suppression forcée";
      return entry.applied_at ? "modifié depuis son application" : "modifications non intégrées";
    case "active":
      return entry.status === "pending" ? "tâche en attente" : "tâche en cours";
    case "inspection_failed":
      return `inspection impossible${entry.error ? ` : ${entry.error}` : ""}`;
  }
}
```

et dans `keptAdvice`, entre le cas orphelin et le cas général (conserver la docstring existante) :

```ts
  if (entry.applied_at) {
    return `"${entry.id}" : appliqué puis modifié — "orch diff ${entry.id}" pour voir ce qui a bougé depuis l'application, "orch apply ${entry.id}" pour ré-appliquer.`;
  }
```

(Le cas orphelin doit rester **avant** : un orphelin n'a pas d'enregistrement, donc jamais d'`applied_at` — l'ordre actuel `orphan` puis `applied_at` puis général est le bon. `jsonEntry` reste inchangé : ses `diff_command`/`apply_command` valent aussi pour un conservé « modifié depuis son application ».)

- [ ] **Step 4 : Vérifier le passage**

Run : `pnpm vitest run packages/cli/src/commands/gc.test.ts`
Attendu : PASS.

- [ ] **Step 5 : Commit**

```bash
git add packages/cli/src/commands/gc.ts packages/cli/src/commands/gc.test.ts
git commit -m "Dit « appliqué » quand le gc collecte un worktree appliqué

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6 : La connaissance déposée dit l'invocation et le cycle complet

**Files:**
- Modify: `.claude/skills/orch/references/cli.md`
- Modify: `.claude/skills/orch/SKILL.md`
- Modify: `.claude/skills/orch/references/troubleshooting.md`
- Regenerate: `packages/core/src/agent-assets.generated.ts` (via `pnpm run assets:sync`, jamais à la main)

**Interfaces:**
- Consumes: le comportement livré par les Tasks 2-5 (les textes le décrivent).
- Produces: le catalogue d'assets régénéré, que `orch init` déposera dans les projets.

- [ ] **Step 1 : Committer d'abord la modification en cours du dépôt**

`git status` porte une modification **antérieure à ce plan** (description de la skill resserrée, déjà synchronisée dans le catalogue). La committer seule pour que la suite reste relisible :

```bash
git add .claude/skills/orch/SKILL.md packages/core/src/agent-assets.generated.ts
git commit -m "Resserre la description de déclenchement de la skill orch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Si `git status` est propre à ce stade, sauter ce step.)

- [ ] **Step 2 : Éditer `references/cli.md`**

Insérer, entre le paragraphe d'introduction (« …passing raw arguments through to a provider. ») et `## Getting started` :

```markdown
## Invocation

`orch` is a standalone binary on the PATH — never a dependency of the project. `npx orch` always
fails with `could not determine executable to run`, whatever the project's `package.json` says:
call `orch` directly. When in doubt, `command -v orch` says where it lives and `orch doctor` says
what it can reach.
```

Puis, sous le tableau contenant la ligne `orch gc` (~ligne 80), ajouter ce paragraphe (adapter l'emplacement exact à la structure du fichier — juste après le tableau si aucune prose n'y suit) :

```markdown
`orch gc` removes the worktrees and branches of finished tasks. A worktree whose diff was applied
(`orch apply`) is collected as long as nothing changed in it since the application — the
application is recorded on the task, so gc never has to guess. What it keeps is exactly the work
that was never applied, or modified after it: settle it with `orch diff`/`orch apply`, or discard
it knowingly with `--force`.
```

- [ ] **Step 3 : Éditer `SKILL.md`**

Dans le paragraphe « **Applying is a decision, not a final step.** », remplacer :

```
State what is being applied and which criterion it met; when it met none, say so and leave the
worktree unapplied — `orch gc` collects the worktrees of finished tasks, keeping any that still
carry changes unless `--force` (see `references/cli.md`). A diff nobody can defend is not cheaper
for having been written elsewhere.
```

par :

```
State what is being applied and which criterion it met; when it met none, say so and leave the
worktree unapplied. Close the loop with `orch gc` once the session's delegations are settled:
applied worktrees are collected on their own, and what gc keeps is exactly the work never applied
— or modified since its application — to settle with `orch diff`/`orch apply` rather than a
reflexive `--force` (see `references/cli.md`). A diff nobody can defend is not cheaper for having
been written elsewhere.
```

- [ ] **Step 4 : Éditer `references/troubleshooting.md`**

Ajouter à la fin du fichier, dans le format des entrées existantes :

```markdown
## `npx orch` fails: could not determine executable to run

**Symptom.** Any `npx orch …` invocation fails immediately with npm's
`could not determine executable to run`.

**Cause.** `orch` is a standalone binary installed on the PATH, never an npm dependency of the
project: there is nothing under `node_modules/.bin` for npx to find, whatever the project.

**Remedy.** Call `orch` directly. `command -v orch` tells where the binary lives; `orch doctor`
confirms what it can reach. If the shell finds nothing, the installation is missing — not the
project's `package.json`.

## `orch gc` keeps a worktree whose diff was already applied

**Symptom.** `orch gc` reports a finished task's worktree as kept — "unintegrated changes", or
"modified since its application" — even though its diff has landed in the workspace.

**Cause.** Three possibilities. The diff entered the workspace by another path than `orch apply`
(manual copy, re-implementation): the application was never recorded, and gc will not deduce it
from content. Or the worktree changed after the application: what changed is precisely what was
never applied. Or the application predates the version of orch that records it.

**Remedy.** `orch diff <id>` shows what the worktree still carries. Re-run `orch apply <id>` if it
should land; once settled — or when the work is known to be integrated — `orch gc --force` removes
what gc could not prove applied.
```

- [ ] **Step 5 : Régénérer le catalogue et vérifier**

```bash
pnpm run assets:sync
pnpm vitest run packages/core/src/agent-assets.drift.test.ts packages/core/src/agent-assets.invariants.test.ts packages/core/src/agent-assets.test.ts
```

Attendu : PASS (aucune dérive entre sources et catalogue).

- [ ] **Step 6 : Commit**

```bash
git add .claude/skills/orch/SKILL.md .claude/skills/orch/references/cli.md .claude/skills/orch/references/troubleshooting.md packages/core/src/agent-assets.generated.ts
git commit -m "Documente l'invocation du binaire et le cycle apply → gc dans les assets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7 : Vérification complète, binaire, déploiement dans `support`

**Files:**
- Aucune création ni modification de source — exécution et vérification.

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: binaire `dist-bin/orch` reconstruit (le symlink `~/.local/bin/orch` pointe déjà dessus) ; projet `support` rafraîchi et purgé.

- [ ] **Step 1 : Suite complète et build**

```bash
pnpm build && pnpm test
```

Attendu : tout vert. Sinon : corriger avant d'aller plus loin, jamais de déploiement sur du rouge.

- [ ] **Step 2 : Reconstruire le binaire**

```bash
pnpm run build:binary
orch --version
```

Attendu : la version s'affiche (le symlink `~/.local/bin/orch → dist-bin/orch` prend la nouvelle build sans autre geste).

- [ ] **Step 3 : Rafraîchir les assets de `support`**

```bash
cd /Users/tharsan/Workspace/koumalabs/support && orch init --json
```

Attendu : sortie JSON avec la clé `assets` ; `.orch/config.toml` et `.orch/roles/*.md` intouchés (comportement documenté du refresh sans `--force`). Vérifier que `.claude/skills/orch/references/cli.md` du projet contient désormais « standalone binary on the PATH ».

- [ ] **Step 4 : Purger les deux worktrees hérités**

Les tâches `t_026622fbf0984832bbf31e747c4f2208` et `t_8a403767545d402a88b43c0112fcedbf` datent d'avant l'enregistrement du fait d'application : leur intégration a été vérifiée fichier par fichier le 2026-08-12 (spec, § Déploiement). Dans `/Users/tharsan/Workspace/koumalabs/support` :

```bash
orch gc --dry-run   # attendu : les deux conservés, « modifications non intégrées » — normal, enregistrements antérieurs au mécanisme
orch gc --force     # attendu : les deux supprimés, raison « modifications non intégrées, suppression forcée »
orch gc             # attendu : « Aucun worktree à nettoyer. »
```

- [ ] **Step 5 : Vérification de bout en bout du nouveau cycle (optionnelle mais recommandée)**

Dans un dépôt d'essai (par ex. `/Users/tharsan/Workspace/orch-essai`), dérouler une délégation worktree réelle, puis :

```bash
orch apply <task_id>   # applique et enregistre
orch gc --dry-run      # attendu : « serait supprimé », raison « appliqué au workspace, rien de nouveau depuis »
orch gc                # attendu : supprimé sans --force
```

## Self-review du plan

- **Couverture du spec :** apply enregistré (Tasks 1-2), gc collecte + libellés (Tasks 3, 5), façades (Task 4), connaissance invocation + cycle + troubleshooting (Task 6), tests des trois volets (Tasks 1-5), déploiement `support` (Task 7). Le point de vigilance dry-run du spec est tranché en Task 3 (docstring d'`appliedAndUnchanged` : l'index du worktree jetable peut être touché, le workspace et le store jamais) et testé (test dry-run : store non réécrit, worktree présent).
- **Types cohérents :** `applied_at`/`applied_patch_digest` (Tasks 1→2→3→4), `RecordedApplyResult.outcome` (`"applied" | "conflicts" | "no_worktree"`) consommé tel quel en Task 4, raison `"applied"` et `WorktreeGcEntry.applied_at` (Task 3) consommés en Task 5.
- **Pas de placeholder :** chaque step porte son code ou sa commande ; les deux seuls renvois (helpers de capture des tests CLI existants, helper `appliedRecordedWorktree` recopié du test core) nomment leur source exacte.
