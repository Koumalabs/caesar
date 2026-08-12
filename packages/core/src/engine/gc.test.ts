import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPORT_PROTOCOL, readReport, taskPaths, writeReport } from "@orch/protocol";
import type { TaskRecord, TaskStatus } from "../store.js";
import { fileTaskStore } from "../store.js";
import { createWorktree } from "./worktree.js";
import {
  clearWorktreeInUse,
  detectAbandonedTasks,
  garbageCollectWorktrees,
  markWorktreeInUse,
  sweepAbandonedTasks,
} from "./gc.js";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Au-delà de toute valeur que `kill(pid, 0)` puisse trouver vivante, sur macOS
 * comme sous Linux : le marqueur qui le porte est périmé par construction,
 * sans avoir à tuer un vrai processus ni à parier sur un pid non réattribué.
 */
const DEAD_PID = 2_147_483_647;

/** Le marqueur qu'un orchestrateur tué laisse derrière lui. Rend son chemin. */
async function staleMarker(root: string, id: string): Promise<string> {
  const lease = await markWorktreeInUse(root, id);
  await writeFile(lease.path, JSON.stringify({ pid: DEAD_PID, token: lease.token }) + "\n", "utf8");
  return lease.path;
}

describe("garbageCollectWorktrees", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-gc-repo-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createRecordedWorktree(id: string, status: TaskStatus): Promise<TaskRecord> {
    const handle = await createWorktree(root, id);
    const record: TaskRecord = {
      id,
      agent: "codex",
      objective: "tester le ramasse-miettes",
      status,
      created_at: "2026-08-11T10:00:00.000Z",
      ended_at: status === "pending" || status === "running" ? undefined : "2026-08-11T10:01:00.000Z",
      task_dir: join(root, ".orch", "tasks", id),
      workspace: handle.path,
      isolation: "worktree",
      mode: "write",
      branch: handle.branch,
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);
    return record;
  }

  it("--dry-run annonce un worktree terminé propre sans supprimer le worktree ni la branche", async () => {
    const record = await createRecordedWorktree("t_propre", "succeeded");

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: record.id,
        action: "would_remove",
        reason: "clean",
        orphan: false,
        status: "succeeded",
      }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(root, ["branch", "--list", record.branch!])).toContain(record.branch!);
  });

  it("supprime le worktree terminé propre et sa branche", async () => {
    const record = await createRecordedWorktree("t_supprimee", "failed");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "clean", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await git(root, ["worktree", "list"]))).not.toContain(record.id);
    expect((await git(root, ["branch", "--list", record.branch!])).trim()).toBe("");
  });

  it("conserve un worktree terminé modifié, puis le supprime avec --force", async () => {
    const record = await createRecordedWorktree("t_modifiee", "cancelled");
    await writeFile(join(record.workspace, "travail.txt"), "important\n", "utf8");
    const statusBefore = await git(record.workspace, ["status", "--porcelain"]);

    const kept = await garbageCollectWorktrees(root);

    expect(kept.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(record.workspace, ["status", "--porcelain"])).toBe(statusBefore);

    const removed = await garbageCollectWorktrees(root, { force: true });
    expect(removed.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "modified", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
  });

  it.each(["pending", "running"] as const)("ne supprime jamais une tâche %s, même avec --force", async (status) => {
    const record = await createRecordedWorktree(`t_${status}`, status);
    await writeFile(join(record.workspace, "en-cours.txt"), "écriture\n", "utf8");

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "active", status }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(root, ["branch", "--list", record.branch!])).toContain(record.branch!);
  });

  it("détecte et supprime un worktree orphelin absent du store", async () => {
    const handle = await createWorktree(root, "t_orpheline");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: "t_orpheline",
        action: "removed",
        reason: "clean",
        orphan: true,
        status: undefined,
      }),
    ]);
    expect(await pathExists(handle.path)).toBe(false);
    expect((await git(root, ["branch", "--list", handle.branch])).trim()).toBe("");
  });

  /**
   * Le pendant, côté ramasse-miettes, de la garantie constatée dans
   * `worktree.test.ts` : c'est le chemin le plus exposé — nettoyage
   * automatique, sans supervision, sur un worktree dont plus rien ne dit
   * quels chemins avaient été liés (`[worktree] link`) — et celui qui doit le
   * moins pouvoir détruire le `node_modules` du dépôt principal.
   */
  it("un worktree contenant un lien vers le dépôt principal est nettoyé sans détruire sa cible", async () => {
    const { mkdir, readFile, symlink } = await import("node:fs/promises");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "marqueur.txt"), "précieux\n", "utf8");

    const handle = await createWorktree(root, "t_lien");
    await symlink(join(root, "node_modules"), join(handle.path, "node_modules"), "dir");

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([expect.objectContaining({ id: "t_lien", action: "removed", orphan: true })]);
    expect(await pathExists(handle.path)).toBe(false);
    expect(await readFile(join(root, "node_modules", "marqueur.txt"), "utf8")).toBe("précieux\n");
  });

  it("protège un worktree en cours de création avant son apparition dans le store", async () => {
    const lease = await markWorktreeInUse(root, "t_demarrage");
    const handle = await createWorktree(root, "t_demarrage");

    const protectedResult = await garbageCollectWorktrees(root, { force: true });

    expect(protectedResult.entries).toEqual([
      expect.objectContaining({ id: "t_demarrage", action: "kept", reason: "active", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(true);

    await clearWorktreeInUse(lease);
    const collectedResult = await garbageCollectWorktrees(root);
    expect(collectedResult.entries).toEqual([
      expect.objectContaining({ id: "t_demarrage", action: "removed", reason: "clean", orphan: true }),
    ]);
  });

  it("--dry-run ne purge pas un marqueur laissé par un processus mort", async () => {
    const id = "t_marqueur_perime";
    const lease = await markWorktreeInUse(root, id);
    const marker = lease.path;
    await writeFile(marker, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");
    const handle = await createWorktree(root, id);

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id, action: "would_remove", reason: "clean", orphan: true }),
    ]);
    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(handle.path)).toBe(true);
  });

  /**
   * La conséquence composée, et la raison d'être du balayage : le statut
   * "running" d'une tâche dont l'orchestrateur est mort protégeait son
   * worktree à vie (`kept: active`), et le processus qui aurait dû lever cette
   * protection n'existait plus. Le worktree, sa branche et tout ce qu'on y
   * avait cloné restaient là pour toujours.
   */
  it("conclut une tâche abandonnée, puis collecte le worktree qu'elle retenait", async () => {
    const record = await createRecordedWorktree("t_abandonnee", "running");
    await staleMarker(root, record.id);

    const result = await garbageCollectWorktrees(root);

    expect(result.abandoned).toEqual([{ id: record.id, status: "running", pid: DEAD_PID }]);
    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "clean", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await fileTaskStore(root).get(record.id))?.status).toBe("failed");
  });

  it("--dry-run annonce la tâche abandonnée et son worktree, sans rien écrire", async () => {
    const record = await createRecordedWorktree("t_abandonnee_apercu", "running");
    const marker = await staleMarker(root, record.id);

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.abandoned).toEqual([{ id: record.id, status: "running", pid: DEAD_PID }]);
    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "would_remove", reason: "clean" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await pathExists(marker)).toBe(true);
    expect((await fileTaskStore(root).get(record.id))?.status).toBe("running");
  });

  it("conserve un orphelin dont le marqueur est illisible, même avec --force", async () => {
    const id = "t_marqueur_invalide";
    const lease = await markWorktreeInUse(root, id);
    await writeFile(lease.path, "{json incomplet", "utf8");
    const handle = await createWorktree(root, id);

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id, action: "kept", reason: "inspection_failed", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(true);
  });
});

/**
 * Le décalage entre la racine *orch* et la racine *git*. `resolveRoot` (CLI)
 * s'arrête au premier `.orch/` **ou** `.git/` : quand `.orch/` vit dans un
 * sous-répertoire d'un dépôt, les deux divergent. `createWorktree` crée sous la
 * racine git ; le gc balayait `<root>/.orch/wt`, c'est-à-dire un répertoire où
 * rien n'est jamais créé — les orphelins y étaient purement invisibles.
 */
describe("garbageCollectWorktrees — racine orch distincte de la racine git", () => {
  let repo: string;
  let orchRoot: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "orch-gc-split-"));
    await initRepo(repo);
    orchRoot = join(repo, "sous-projet");
    await execFileAsync("mkdir", ["-p", join(orchRoot, ".orch")]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("trouve et nettoie un orphelin créé sous la racine git", async () => {
    const handle = await createWorktree(repo, "t_sous_projet");

    const result = await garbageCollectWorktrees(orchRoot);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: "t_sous_projet", action: "removed", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(false);
    expect((await git(repo, ["branch", "--list", handle.branch])).trim()).toBe("");
  });
});

/**
 * La branche vient de `git worktree list --porcelain`, jamais d'une déduction
 * sur le nom du répertoire (`orch/<dirname>`) : cette coïncidence de
 * construction laisserait des branches derrière elle dès que les deux
 * cesseraient d'être fabriqués ensemble — ce que le nommage lisible des
 * branches fait précisément.
 */
describe("garbageCollectWorktrees — la branche vient de git", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-gc-branch-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("nettoie la branche réelle d'un orphelin dont le nom ne se déduit pas du répertoire", async () => {
    const path = join(root, ".orch", "wt", "t_libre");
    await execFileAsync("mkdir", ["-p", join(root, ".orch", "wt")]);
    await git(root, ["worktree", "add", "-q", "-b", "orch/implementer/refonte-du-cache-t_libre", path]);

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: "t_libre", branch: "orch/implementer/refonte-du-cache-t_libre", action: "removed" }),
    ]);
    expect((await git(root, ["branch", "--list", "orch/implementer/refonte-du-cache-t_libre"])).trim()).toBe("");
  });
});

/**
 * Le statut d'une tâche est écrit par le processus qui la conduit, dans son
 * `finally`. Tué — `kill -9`, fermeture de la session MCP qui l'hébergeait,
 * arrêt de la machine — il ne l'écrit jamais, et l'enregistrement reste
 * « running » à vie : `orch ps` l'affiche indéfiniment en tête, `orch watch`
 * la suit sans fin, et `orch gc` protège son worktree comme celui d'une tâche
 * bien vivante. Rien ne réconciliait cet état.
 */
describe("sweepAbandonedTasks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-gc-abandon-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function record(id: string, status: TaskStatus): Promise<TaskRecord> {
    const value: TaskRecord = {
      id,
      agent: "codex",
      objective: "tester la réconciliation",
      status,
      created_at: "2026-08-11T10:00:00.000Z",
      started_at: "2026-08-11T10:00:00.000Z",
      task_dir: join(root, ".orch", "tasks", id),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
      pid: DEAD_PID,
    };
    await fileTaskStore(root).create(value);
    return value;
  }

  it("conclut une tâche dont le marqueur nomme un processus disparu", async () => {
    const task = await record("t_orpheline", "running");
    const marker = await staleMarker(root, task.id);

    const abandoned = await sweepAbandonedTasks(root);

    expect(abandoned).toEqual([{ id: task.id, status: "running", pid: DEAD_PID }]);
    const updated = await fileTaskStore(root).get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.ended_at).toBeDefined();
    expect(updated?.pid).toBeUndefined();
    expect(updated?.report_status).toBe("failed");
    // Le marqueur périmé est repris : sans cela, il resterait sur le disque à
    // jamais — le balayage des orphelins ne visite que ce que git connaît.
    expect(await pathExists(marker)).toBe(false);
  });

  it("dit dans le rapport ce que le statut ne peut pas dire", async () => {
    const task = await record("t_rapport", "running");
    await staleMarker(root, task.id);

    await sweepAbandonedTasks(root);

    const report = await readReport(taskPaths(task.task_dir));
    expect(report?.status).toBe("failed");
    expect(report?.summary).toContain(String(DEAD_PID));
    expect(report?.summary).toContain("recoupé avec git");
  });

  it("n'écrase jamais le rapport que l'agent avait eu le temps d'écrire", async () => {
    const task = await record("t_rapport_agent", "running");
    await staleMarker(root, task.id);
    const paths = taskPaths(task.task_dir);
    await writeReport(paths, {
      protocol: REPORT_PROTOCOL,
      task_id: task.id,
      status: "partial",
      summary: "La moitié du travail est faite.",
    });

    await sweepAbandonedTasks(root);

    const report = await readReport(paths);
    expect(report?.summary).toBe("La moitié du travail est faite.");
    // Le processus, lui, reste en échec : personne n'a vu son code de sortie.
    const updated = await fileTaskStore(root).get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.report_status).toBe("partial");
  });

  it("ne touche pas à une tâche dont le marqueur nomme un processus vivant", async () => {
    const task = await record("t_vivante", "running");
    const lease = await markWorktreeInUse(root, task.id);

    expect(await sweepAbandonedTasks(root)).toEqual([]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("running");

    await clearWorktreeInUse(lease);
  });

  /**
   * L'absence n'est pas une preuve de mort : un enregistrement écrit par autre
   * chose que le moteur n'a jamais pris de marqueur, et ne doit pas être
   * déclaré mort pour autant. `orch cancel` reste la sortie manuelle.
   */
  it("ne conclut rien d'une tâche sans marqueur", async () => {
    const task = await record("t_sans_marqueur", "running");

    expect(await sweepAbandonedTasks(root)).toEqual([]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("running");
  });

  it("ne touche pas aux tâches déjà terminées", async () => {
    const task = await record("t_terminee", "succeeded");
    await staleMarker(root, task.id);

    expect(await sweepAbandonedTasks(root)).toEqual([]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("succeeded");
  });

  it("conclut aussi une tâche morte avant son lancement", async () => {
    const task = await record("t_jamais_lancee", "pending");
    await staleMarker(root, task.id);

    const abandoned = await sweepAbandonedTasks(root);

    expect(abandoned).toEqual([{ id: task.id, status: "pending", pid: DEAD_PID }]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("failed");
  });

  it("detectAbandonedTasks constate sans rien écrire", async () => {
    const task = await record("t_constat", "running");
    const marker = await staleMarker(root, task.id);

    expect(await detectAbandonedTasks(root)).toEqual([{ id: task.id, status: "running", pid: DEAD_PID }]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("running");
    expect(await pathExists(marker)).toBe(true);
  });
});
