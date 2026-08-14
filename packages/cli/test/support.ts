/**
 * Utilities shared by the CLI tests.
 *
 * Two guardrails from the task 6 brief to honor systematically: no test
 * must touch the real `~/.config/caesar/`, and none must invoke a real
 * agent CLI. `withFakeHome` isolates the former; `withShimmedPath` enables
 * the latter by substituting, on a fully controlled `PATH`, a fake script
 * for the binary of an agent of the catalog — the engine (registry, real
 * adapter, environment contract) then runs for real, only the external
 * process is a fake agent.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Io } from "../src/output.js";

export interface CapturedIo extends Io {
  stdoutText(): string;
  stderrText(): string;
}

/** An `Io` whose streams are captured in memory rather than written to the terminal — never any `isTTY`, hence never any color. */
export function makeIo(): CapturedIo {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(chunk.toString());
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stdout,
    stderr,
    stdoutText: () => stdoutChunks.join(""),
    stderrText: () => stderrChunks.join(""),
  };
}

/**
 * Runs `fn` with `HOME` pointed at a freshly created temporary directory,
 * guaranteeing no real `~/.config/caesar/config.toml` is read or written —
 * same motive as `packages/core/src/config.test.ts`.
 */
export async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "caesar-cli-home-"));
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

/**
 * Runs `fn` with a `PATH` entirely replaced by `shimDir` plus the
 * directories strictly needed to resolve `/usr/bin/env` (the fake scripts
 * all use that shebang) and `node` itself. Result: only the binaries
 * explicitly deposited in `shimDir` are "installed" — no agent actually
 * present on the machine can skew the test.
 */
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
 * than a copy of its content: a copy would break the module resolution of
 * any import the script does itself (the fake agent's "ask" mode, task 9,
 * dynamically imports `@modelcontextprotocol/sdk` — a copy deposited in
 * this temporary shim directory, unrelated to the monorepo, would not
 * resolve it). Same fix as `packages/mcp-server/test/support.ts` (task 10, A4).
 */
async function shimFrom(dir: string, bin: string, sourcePath: string): Promise<void> {
  const target = join(dir, bin);
  const redirect = `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(sourcePath).href)});\n`;
  await writeFile(target, redirect, "utf8");
  await chmod(target, 0o755);
}

/** Path of the fake agent shared by `@caesar/core` (see its brief: reused as-is, never duplicated). */
export const FAKE_AGENT_PATH = fileURLToPath(new URL("../../core/test/fixtures/fake-agent.mjs", import.meta.url));

/**
 * Creates a temporary shim directory where `bin` (e.g. "codex") is in
 * reality a copy of the `@caesar/core` fake agent. The registry's real
 * adapter builds its specific arguments (Codex flags, etc.), but the fake
 * script ignores them and only looks at the minimal contract's environment
 * variables ($CAESAR_TASK_FILE, $CAESAR_REPORT_PATH…) — a complete and
 * realistic round trip, without ever touching the agent's real binary.
 */
export async function withFakeAgentAsBin<T>(bin: string, fn: (shimDir: string) => Promise<T>): Promise<T> {
  const shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-shim-"));
  try {
    await shimFrom(shimDir, bin, FAKE_AGENT_PATH);
    return await withShimmedPath(shimDir, () => fn(shimDir));
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
}

/**
 * Sets `allow_inplace_write = true` in `root`'s project layer.
 *
 * A write task explicitly asking for `isolation = "inplace"` in a usable
 * git repository is refused by default (see `decideInplaceWrite`,
 * `@caesar/core`): it is the fix for the defect that let delegations write
 * on the user's working branch silently. Tests exercising *something else*
 * than that rule — a full round trip, a timeout, an exit code — do not have
 * to endure it, but they must assume it explicitly, exactly as a user
 * would.
 *
 * Inserts the key into an existing `[policy]` rather than overwriting the
 * file: several tests already write their own project layer (`[[agent]]`,
 * …), and two `[policy]` tables in a single TOML would be a parse error.
 */
export async function allowInplaceWrite(root: string): Promise<void> {
  const path = join(root, ".caesar", "config.toml");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // No project layer: we create one.
  }
  const line = "allow_inplace_write = true\n";
  const next = existing.includes("[policy]")
    ? existing.replace("[policy]\n", `[policy]\n${line}`)
    : `[policy]\n${line}\n${existing}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
}

/** Deposits a minimal script answering `--version` successfully, for the `caesar doctor` tests. */
export async function writeVersionOkShim(dir: string, bin: string, version: string): Promise<void> {
  const target = join(dir, bin);
  await writeFile(
    target,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)} + "\\n");\nprocess.exit(0);\n`,
    "utf8",
  );
  await chmod(target, 0o755);
}

/** Deposits a minimal script that always fails (including on --version), for the `caesar doctor` tests. */
export async function writeVersionFailShim(dir: string, bin: string): Promise<void> {
  const target = join(dir, bin);
  await writeFile(target, `#!/usr/bin/env node\nprocess.exit(1);\n`, "utf8");
  await chmod(target, 0o755);
}
