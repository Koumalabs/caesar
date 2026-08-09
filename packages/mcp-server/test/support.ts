/**
 * Utilitaires partagés par les tests du serveur MCP.
 *
 * Mêmes garde-fous que `packages/cli/test/support.ts` (dont ce fichier
 * reprend le motif, faute d'un point d'export commun entre les deux
 * packages de test) : aucun test ne doit toucher `~/.config/orch/` ni un
 * autre fichier de configuration réel, ni invoquer un vrai CLI d'agent —
 * `withFakeHome` isole le premier, `withFakeAgentAsBin`/`withShimmedPath` le
 * second, en substituant l'agent factice de `@orch/core` au binaire réel
 * d'un agent du catalogue, sur un `PATH` entièrement maîtrisé.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "orch-mcp-home-"));
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

export async function withShimmedPath<T>(shimDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env["PATH"];
  const minimal = [shimDir, "/usr/bin", "/bin", dirname(process.execPath)].join(delimiter);
  process.env["PATH"] = minimal;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}

async function shimFrom(dir: string, bin: string, sourcePath: string): Promise<void> {
  const content = await readFile(sourcePath, "utf8");
  const target = join(dir, bin);
  await writeFile(target, content, "utf8");
  await chmod(target, 0o755);
}

/** Chemin de l'agent factice partagé par `@orch/core` — réutilisé tel quel, jamais dupliqué (voir son brief). */
export const FAKE_AGENT_PATH = fileURLToPath(new URL("../../core/test/fixtures/fake-agent.mjs", import.meta.url));

export async function withFakeAgentAsBin<T>(bin: string, fn: (shimDir: string) => Promise<T>): Promise<T> {
  const shimDir = await mkdtemp(join(tmpdir(), "orch-mcp-shim-"));
  try {
    await shimFrom(shimDir, bin, FAKE_AGENT_PATH);
    return await withShimmedPath(shimDir, () => fn(shimDir));
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
}

/** Dépôt git minimal, pour les tests qui exercent l'isolation "worktree" (`orch_diff`/`orch_apply`). */
export async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "orch-test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Orch Test"], { cwd: root });
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "a.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
}
