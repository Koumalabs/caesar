/**
 * Utilities shared by the MCP server tests.
 *
 * Same guardrails as `packages/cli/test/support.ts` (whose pattern this
 * file reprises, for lack of a shared export point between the two test
 * packages): no test may touch `~/.config/caesar/` or any other real
 * configuration file, nor invoke a real agent CLI — `withFakeHome` isolates
 * the former, `withFakeAgentAsBin`/`withShimmedPath` the latter, by
 * substituting the fake agent from `@caesar/core` for a catalog agent's
 * real binary, on a fully controlled `PATH`.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "caesar-mcp-home-"));
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

/**
 * Writes, under `dir/bin`, a one-line redirector to `sourcePath` rather
 * than a copy of its content: a copy would break module resolution for any
 * import the script does itself (the fake agent's "ask" mode, task 9,
 * dynamically imports `@modelcontextprotocol/sdk` — a copy dropped into
 * this temporary shim directory, unrelated to the monorepo, would not
 * resolve it). `import(...)` is valid whether a file is interpreted as ESM
 * or CommonJS; behavior unchanged for every existing usage, which imported
 * nothing itself.
 */
async function shimFrom(dir: string, bin: string, sourcePath: string): Promise<void> {
  const target = join(dir, bin);
  const redirect = `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(sourcePath).href)});\n`;
  await writeFile(target, redirect, "utf8");
  await chmod(target, 0o755);
}

/** Path of the fake agent shared by `@caesar/core` — reused as-is, never duplicated (see its brief). */
export const FAKE_AGENT_PATH = fileURLToPath(new URL("../../core/test/fixtures/fake-agent.mjs", import.meta.url));

export async function withFakeAgentAsBin<T>(bin: string, fn: (shimDir: string) => Promise<T>): Promise<T> {
  const shimDir = await mkdtemp(join(tmpdir(), "caesar-mcp-shim-"));
  try {
    await shimFrom(shimDir, bin, FAKE_AGENT_PATH);
    return await withShimmedPath(shimDir, () => fn(shimDir));
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
}

/** Minimal git repository, for tests that exercise "worktree" isolation (`caesar_diff`/`caesar_apply`). */
export async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "caesar-test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Caesar Test"], { cwd: root });
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "a.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
}
