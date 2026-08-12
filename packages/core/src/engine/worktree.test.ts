import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_PROTOCOL, TaskSchema, taskPaths, writeTask } from "@orch/protocol";
import type { Task } from "@orch/protocol";
import { fileTaskStore } from "../store.js";
import type { TaskRecord } from "../store.js";
import {
  applyRecordedWorktree,
  createWorktree,
  describeWorkspaceMismatch,
  diffWorktree,
  listGitWorktrees,
  loadWorktreeHandle,
  patchDigest,
  removeWorktree,
  repoRoot,
  worktreesDirIgnored,
} from "./worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepo(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "orch-test@example.com"]);
  await git(root, ["config", "user.name", "Orch Test"]);
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

describe("worktree", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-worktree-repo-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("repoRoot", () => {
    it("résout la racine d'un dépôt git", async () => {
      const resolved = await repoRoot(root);
      // macOS résout /tmp en /private/tmp : on compare les chemins réels.
      expect(resolved).toBe(await realpath(root));
    });

    it("renvoie null hors d'un dépôt git", async () => {
      const outside = await mkdtemp(join(tmpdir(), "orch-not-a-repo-"));
      try {
        expect(await repoRoot(outside)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("createWorktree / diffWorktree", () => {
    it("crée le worktree sous <root>/.orch/wt/<taskId> sur la branche orch/<taskId>", async () => {
      const handle = await createWorktree(root, "task-1");
      expect(handle.path).toBe(join(root, ".orch", "wt", "task-1"));
      expect(handle.branch).toBe("orch/task-1");
      // Un SHA, jamais la chaîne "HEAD" : c'est ce qui rend le diff insensible
      // aux commits que l'agent fait dans son atelier.
      expect(handle.baseRef).toMatch(/^[0-9a-f]{40}$/);
      expect(handle.baseRef).toBe((await git(root, ["rev-parse", "HEAD"])).trim());

      const content = await readFile(join(handle.path, "a.txt"), "utf8");
      expect(content).toBe("hello\n");

      const branches = await git(root, ["branch", "--list", "orch/task-1"]);
      expect(branches).toContain("orch/task-1");
    });

    it("voit un fichier créé sans commit, grâce à --intent-to-add", async () => {
      const handle = await createWorktree(root, "task-2");
      await writeFile(join(handle.path, "nouveau.txt"), "contenu\n", "utf8");
      await writeFile(join(handle.path, "a.txt"), "hello\nmodifié\n", "utf8");

      const diff = await diffWorktree(handle);
      expect(diff.isEmpty).toBe(false);
      expect(diff.files).toEqual(
        expect.arrayContaining([
          { path: "nouveau.txt", action: "created", summary: "" },
          { path: "a.txt", action: "modified", summary: "" },
        ]),
      );
      expect(diff.patch).toContain("nouveau.txt");
      expect(diff.patch).toContain("+contenu");
    });

    it("diff vide quand le worktree n'a subi aucun changement", async () => {
      const handle = await createWorktree(root, "task-3");
      const diff = await diffWorktree(handle);
      expect(diff.isEmpty).toBe(true);
      expect(diff.files).toEqual([]);
      expect(diff.patch).toBe("");
    });

    it("rapporte une suppression comme telle", async () => {
      const handle = await createWorktree(root, "task-4");
      await rm(join(handle.path, "a.txt"));
      const diff = await diffWorktree(handle);
      expect(diff.files).toEqual([{ path: "a.txt", action: "deleted", summary: "" }]);
    });

    /**
     * L'atelier lève l'hypothèse sous laquelle ce module a été écrit — « les
     * agents ne committent pas ». Un sous-agent qui installe, lance les tests
     * et jalonne son travail par des commits est exactement ce que le worktree
     * doit permettre ; le diff doit y survivre.
     */
    describe("un agent qui commite dans son atelier", () => {
      async function commitAll(dir: string, message: string): Promise<void> {
        await git(dir, ["config", "user.email", "agent@example.com"]);
        await git(dir, ["config", "user.name", "Sous-agent"]);
        await git(dir, ["add", "-A"]);
        await git(dir, ["commit", "-q", "-m", message]);
      }

      it("voit son travail dans le diff, exactement comme s'il n'avait pas commité", async () => {
        // Diffé contre `HEAD`, ce diff serait vide : `HEAD` désignerait le
        // commit de l'agent lui-même. `orch` aurait conclu « aucun
        // changement », `orch apply` n'aurait rien appliqué, et tout le
        // travail se serait évaporé en silence.
        const handle = await createWorktree(root, "task-commit");
        await writeFile(join(handle.path, "nouveau.txt"), "contenu\n", "utf8");
        await writeFile(join(handle.path, "a.txt"), "hello\nmodifié\n", "utf8");
        await commitAll(handle.path, "travail de l'agent");

        const diff = await diffWorktree(handle);
        expect(diff.isEmpty).toBe(false);
        expect(diff.files).toEqual(
          expect.arrayContaining([
            { path: "nouveau.txt", action: "created", summary: "" },
            { path: "a.txt", action: "modified", summary: "" },
          ]),
        );
        expect(diff.patch).toContain("+contenu");
      });

      it("cumule plusieurs commits en un seul diff contre le point de départ", async () => {
        const handle = await createWorktree(root, "task-commits");
        await writeFile(join(handle.path, "un.txt"), "1\n", "utf8");
        await commitAll(handle.path, "premier jalon");
        await writeFile(join(handle.path, "deux.txt"), "2\n", "utf8");
        await commitAll(handle.path, "second jalon");

        const diff = await diffWorktree(handle);
        expect(diff.files.map((f) => f.path).sort()).toEqual(["deux.txt", "un.txt"]);
      });

      it("mêle un commit et du travail non commité dans le même diff", async () => {
        // Le cas réel de fin de tâche : quelques commits, puis des
        // modifications encore dans l'arbre de travail. Les deux mécanismes —
        // le SHA de départ et `--intent-to-add` — doivent jouer ensemble.
        const handle = await createWorktree(root, "task-mixte");
        await writeFile(join(handle.path, "commite.txt"), "commité\n", "utf8");
        await commitAll(handle.path, "jalon");
        await writeFile(join(handle.path, "en-cours.txt"), "pas encore\n", "utf8");

        const diff = await diffWorktree(handle);
        expect(diff.files.map((f) => f.path).sort()).toEqual(["commite.txt", "en-cours.txt"]);
      });
    });
  });

  describe("removeWorktree", () => {
    it("supprime le worktree et sa branche", async () => {
      const handle = await createWorktree(root, "task-remove");
      await removeWorktree(root, handle);

      const worktrees = await git(root, ["worktree", "list"]);
      expect(worktrees).not.toContain("task-remove");

      const branches = await git(root, ["branch", "--list", "orch/task-remove"]);
      expect(branches.trim()).toBe("");
    });

    /**
     * La garantie sur laquelle repose `[worktree] link` : la cible du lien vit
     * dans le dépôt principal, et sa survie ne doit pas être une supposition.
     * Ces deux tests la constatent plutôt que de la présumer — ils échoueraient
     * le jour où `git worktree remove --force` se mettrait à suivre les liens,
     * ce qui rendrait la matérialisation par lien indéfendable telle quelle.
     */
    it("un lien vers le dépôt principal est détaché, jamais suivi : sa cible survit", async () => {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", "marqueur.txt"), "précieux\n", "utf8");

      const handle = await createWorktree(root, "task-lien");
      await symlink(join(root, "node_modules"), join(handle.path, "node_modules"), "dir");
      await removeWorktree(root, handle);

      expect(await readFile(join(root, "node_modules", "marqueur.txt"), "utf8")).toBe("précieux\n");
      const worktrees = await git(root, ["worktree", "list"]);
      expect(worktrees).not.toContain("task-lien");
    });

    it("y compris pour un lien posé sous un chemin imbriqué", async () => {
      // `[worktree] link` accepte `packages/api/node_modules` : la garantie ne
      // vaut rien si elle s'arrête à la racine du worktree.
      await mkdir(join(root, "cible"), { recursive: true });
      await writeFile(join(root, "cible", "dedans.txt"), "intact\n", "utf8");

      const handle = await createWorktree(root, "task-imbrique");
      await mkdir(join(handle.path, "packages", "api"), { recursive: true });
      await symlink(join(root, "cible"), join(handle.path, "packages", "api", "node_modules"), "dir");
      await removeWorktree(root, handle);

      expect(await readFile(join(root, "cible", "dedans.txt"), "utf8")).toBe("intact\n");
    });
  });

  describe("loadWorktreeHandle", () => {
    function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
      return {
        id: "task-handle",
        agent: "codex",
        objective: "tâche",
        status: "succeeded",
        created_at: new Date().toISOString(),
        task_dir: join(root, ".orch", "tasks", "task-handle"),
        workspace: join(root, ".orch", "wt", "task-handle"),
        isolation: "worktree",
        mode: "write",
        report_via: "file",
        depth: 0,
        branch: "orch/task-handle",
        ...overrides,
      };
    }

    it("null quand l'isolation n'est pas \"worktree\"", async () => {
      const handle = await loadWorktreeHandle(record({ isolation: "inplace", branch: undefined }));
      expect(handle).toBeNull();
    });

    it("null quand isolation \"worktree\" mais sans branche enregistrée", async () => {
      const handle = await loadWorktreeHandle(record({ branch: undefined }));
      expect(handle).toBeNull();
    });

    it("reconstruit le handle depuis task.json, base_ref compris", async () => {
      const rec = record();
      const paths = taskPaths(rec.task_dir);
      const task: Task = {
        protocol: "orch.task/v1",
        id: rec.id,
        created_at: rec.created_at,
        agent: rec.agent,
        objective: rec.objective,
        context: "",
        constraints: [],
        acceptance_criteria: [],
        mode: rec.mode,
        isolation: "worktree",
        workspace: rec.workspace,
        base_ref: "deadbeef",
        deadline_ms: 60_000,
        depth: 0,
        report_path: paths.reportPath,
        events_path: paths.eventsPath,
      };
      await writeTask(paths, task);

      const handle = await loadWorktreeHandle(rec);
      expect(handle).toEqual({ path: rec.workspace, branch: "orch/task-handle", baseRef: "deadbeef" });
    });

    it("base_ref absent de task.json : replie sur \"HEAD\"", async () => {
      const rec = record({ id: "task-handle-2", task_dir: join(root, ".orch", "tasks", "task-handle-2") });
      const paths = taskPaths(rec.task_dir);
      const task: Task = {
        protocol: "orch.task/v1",
        id: rec.id,
        created_at: rec.created_at,
        agent: rec.agent,
        objective: rec.objective,
        context: "",
        constraints: [],
        acceptance_criteria: [],
        mode: rec.mode,
        isolation: "worktree",
        workspace: rec.workspace,
        deadline_ms: 60_000,
        depth: 0,
        report_path: paths.reportPath,
        events_path: paths.eventsPath,
      };
      await writeTask(paths, task);

      const handle = await loadWorktreeHandle(rec);
      expect(handle?.baseRef).toBe("HEAD");
    });
  });
});

/**
 * L'étape 0 du skill `superpowers:using-git-worktrees`, que ce projet
 * supposait acquise : détecter avant de créer. Deux angles morts qu'`orch`
 * n'avait nulle part — l'état du `.gitignore`, et le décalage entre la racine
 * sur laquelle il délègue et celle où l'on travaille.
 */
describe("étape 0 — détecter avant de créer", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-etape0-")));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("worktreesDirIgnored", () => {
    it("faux quand rien n'ignore .orch/wt/", async () => {
      expect(await worktreesDirIgnored(root, "t_1")).toBe(false);
    });

    it("vrai avec la ligne qu'orch init écrit — motif terminé par un slash", async () => {
      // Le cas qui a demandé de reformuler la question : un motif de
      // répertoire ne s'applique à `.orch/wt` qu'à la condition que ce
      // répertoire existe déjà. Interroger le chemin qu'on va occuper
      // (`.orch/wt/<taskId>`) répond dans tous les cas.
      await writeFile(join(root, ".gitignore"), ".orch/wt/\n", "utf8");
      expect(await worktreesDirIgnored(root, "t_1")).toBe(true);
    });

    it("vrai aussi quand tout .orch/ est ignoré", async () => {
      await writeFile(join(root, ".gitignore"), ".orch/\n", "utf8");
      expect(await worktreesDirIgnored(root, "t_1")).toBe(true);
    });

    it("faux quand le .gitignore parle d'autre chose", async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/\n.orch/tasks/\n", "utf8");
      expect(await worktreesDirIgnored(root, "t_1")).toBe(false);
    });
  });

  describe("listGitWorktrees", () => {
    it("rend le dépôt principal puis chaque worktree, avec sa branche", async () => {
      const handle = await createWorktree(root, "t_liste");
      const entries = await listGitWorktrees(root);

      expect(entries[0]!.path).toBe(root);
      const found = entries.find((entry) => entry.path === handle.path);
      // La branche vient de git, jamais d'une déduction sur le nom du
      // répertoire : c'est ce qui permet au gc de nettoyer une branche dont le
      // nom ne se devine pas.
      expect(found!.branch).toBe("orch/t_liste");
    });

    it("rend une liste vide hors d'un dépôt git, plutôt que de lever", async () => {
      const outside = await mkdtemp(join(tmpdir(), "orch-pas-un-depot-"));
      try {
        expect(await listGitWorktrees(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("describeWorkspaceMismatch", () => {
    it("silencieux quand les deux racines coïncident", async () => {
      expect(await describeWorkspaceMismatch(root, root)).toBeNull();
    });

    it("silencieux quand le répertoire courant n'est pas dans un dépôt", async () => {
      // Le répertoire courant du serveur MCP n'est pas une preuve d'intention :
      // hors dépôt, il n'y a aucune raison de croire qu'il désigne un lieu de
      // travail.
      const outside = await mkdtemp(join(tmpdir(), "orch-hors-depot-"));
      try {
        expect(await describeWorkspaceMismatch(root, outside)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("signale le cas Superpowers : on travaille dans un worktree, orch délègue sur le dépôt d'origine", async () => {
      // `orch mcp install` fige `--root` une fois pour toutes. Que l'agent
      // principal passe dans un worktree — ce que le skill lui recommande — et
      // les sous-agents travaillent dans un arbre que plus personne ne regarde.
      const handle = await createWorktree(root, "t_ailleurs");
      const message = await describeWorkspaceMismatch(root, handle.path);
      expect(message).toContain(root);
      expect(message).toContain("orch mcp install");
    });
  });
});

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
