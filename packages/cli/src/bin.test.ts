/**
 * Two levels of testing for `bin.ts`:
 * - a structural test, which builds the program (`buildProgram`) without
 *   ever parsing `process.argv` or touching the disk;
 * - a handful of tests that launch the real compiled binary
 *   (`dist/bin.js`) as a subprocess — the only place in this task where
 *   the binary's own behavior is at stake (commander wiring, exit codes,
 *   stdout/stderr separation), hence justifying a real subprocess rather
 *   than a direct function call.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { buildProgram } from "./bin.js";
import { makeIo, type CapturedIo } from "../test/support.js";

const execFileAsync = promisify(execFile);
const BIN_PATH = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

describe("buildProgram (structural)", () => {
  it("exposes all the subcommands of the brief", () => {
    const io = makeIo();
    const program = buildProgram(io, { value: 0 });
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["agents", "apply", "cancel", "channel", "config", "diff", "doctor", "gc", "init", "logs", "mcp", "policy", "protocol", "ps", "role", "run", "watch"]);

    const agents = program.commands.find((c) => c.name() === "agents")!;
    expect(agents.commands.map((c) => c.name()).sort()).toEqual(["add", "disable", "enable", "list", "remove", "set-model", "test", "unset-model"]);

    const role = program.commands.find((c) => c.name() === "role")!;
    expect(role.commands.map((c) => c.name()).sort()).toEqual(["add", "list", "remove", "show"]);

    const policy = program.commands.find((c) => c.name() === "policy")!;
    expect(policy.commands.map((c) => c.name()).sort()).toEqual(["allow", "deny", "show"]);

    const protocol = program.commands.find((c) => c.name() === "protocol")!;
    expect(protocol.commands.map((c) => c.name()).sort()).toEqual(["schema"]);

    const mcp = program.commands.find((c) => c.name() === "mcp")!;
    expect(mcp.commands.map((c) => c.name()).sort()).toEqual(["install", "serve"]);

    const channel = program.commands.find((c) => c.name() === "channel")!;
    expect(channel.commands.map((c) => c.name()).sort()).toEqual(["serve"]);
  });

  it("\"config\" declares --root/--json via withCommonOptions, like the other subcommands (task 10, C)", () => {
    const io = makeIo();
    const program = buildProgram(io, { value: 0 });
    const config = program.commands.find((c) => c.name() === "config")!;
    const flags = config.options.map((o) => o.long).sort();
    expect(flags).toEqual(["--json", "--root"]);
    // "doctor" goes through the same `withCommonOptions`: we check it
    // carries these two options, without requiring it to carry no other —
    // it declares a `--verbose` of its own, and a command gaining an option
    // of its own must not fail a test that speaks of the *common* options.
    const doctor = program.commands.find((c) => c.name() === "doctor")!;
    expect(doctor.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--json", "--root"]));
  });
});

describe("caesar (compiled binary)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-bin-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--help exits with code 0", async () => {
    const { stdout } = await execFileAsync("node", [BIN_PATH, "--help"]);
    expect(stdout).toContain("Orchestrator of coding sub-agents");
  });

  it("--version prints the package.json version, exits with code 0", async () => {
    const { stdout } = await execFileAsync("node", [BIN_PATH, "--version"]);
    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("\"channel\" is masked from the help (task 12, internal subcommand), but stays reachable", async () => {
    const { stdout } = await execFileAsync("node", [BIN_PATH, "--help"]);
    expect(stdout).not.toContain("channel");

    // Reachable explicitly despite its absence from the help: a missing
    // required option (`--task-dir`) produces its usual error (code 2, like
    // any missing required argument/option elsewhere in this CLI) rather
    // than an unknown command — the subcommand is properly wired, only
    // hidden.
    await expect(execFileAsync("node", [BIN_PATH, "channel", "serve"])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "channel", "serve"]);
    } catch (error) {
      expect((error as { stderr: string }).stderr).toMatch(/--task-dir/);
    }
  });

  it("a missing required argument exits with code 2, message once only on stderr", async () => {
    await expect(execFileAsync("node", [BIN_PATH, "run"])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "run"]);
    } catch (error) {
      const stderr = (error as { stderr: string }).stderr;
      const occurrences = stderr.split("missing required argument").length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("--root and --json work placed after the subcommand, pure JSON output on stdout", async () => {
    const { stdout, stderr } = await execFileAsync("node", [BIN_PATH, "protocol", "schema", "task", "--root", root, "--json"]);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toMatch(/\x1b\[/);
    expect(stderr).toBe("");
  });

  // Task 10, C: the exception net of `bin.ts` now distinguishes a
  // configuration/usage error (code 2, historical behavior) from a real
  // execution failure (code 1) — the two tests below prove each branch
  // rather than relying on merely reading the code.

  it("an invalid configuration file exits with code 2 (configuration error, not execution)", async () => {
    await mkdir(join(root, ".caesar"), { recursive: true });
    await writeFile(join(root, ".caesar", "config.toml"), "this is not valid toml [[[", "utf8");

    await expect(execFileAsync("node", [BIN_PATH, "policy", "show", "--root", root])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "policy", "show", "--root", root]);
    } catch (error) {
      expect((error as { stderr: string }).stderr).toMatch(/invalid TOML/i);
    }
  });

  it("a real unanticipated system error (directory not writable) exits with code 1, not 2", async () => {
    const caesarDir = join(root, ".caesar");
    await mkdir(caesarDir, { recursive: true });
    // Reading always possible (no config.toml: the "absent" path, not an
    // error), writing impossible: `saveProjectConfig` (called by
    // `policy allow`) fails with a real system error (`EACCES`), never
    // rewrapped into a business `Error` — unlike `loadConfig`.
    await chmod(caesarDir, 0o500);
    try {
      await expect(execFileAsync("node", [BIN_PATH, "policy", "allow", "codex", "--root", root])).rejects.toMatchObject({ code: 1 });
    } finally {
      await chmod(caesarDir, 0o700);
    }
  });

  it("\"config --json\" is refused explicitly, not silently ignored (task 10 review)", async () => {
    await expect(execFileAsync("node", [BIN_PATH, "config", "--root", root, "--json"])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "config", "--root", root, "--json"]);
    } catch (error) {
      expect((error as { stderr: string }).stderr).toMatch(/--json/);
    }
  });
});
