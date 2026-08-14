import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaesarEventInput } from "@caesar/protocol";
import { ENV, EventSchema } from "@caesar/protocol";
import { allowInplaceWrite, FAKE_AGENT_PATH, makeIo, withFakeAgentAsBin, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runPolicyDeny } from "./policy.js";
import { describeEvent, formatEventLine, runRun } from "./run.js";
import { runCli } from "../program.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "caesar-test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Caesar Test"], { cwd: root });
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "a.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

/**
 * The repository **and** the opt-in that makes `--isolation inplace`
 * acceptable for writes.
 *
 * The round-trip tests below all ask for `inplace`: they check the exit
 * code, the report, a timeout, a command line — never the isolation rule
 * itself, and a worktree would only add an indirection to them. Since that
 * combination is refused by default, assuming it is part of their setup,
 * exactly as it is for a user. The refusal, for its part, has its own test:
 * "refuses … without the opt-in".
 */
async function initGitRepoAllowingInplaceWrite(root: string): Promise<void> {
  await initGitRepo(root);
  await allowInplaceWrite(root);
}

describe("caesar run", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-run-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("full round trip with a fake agent substituted for the real \"codex\" binary", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        const code = await runRun(
          root,
          "write a file",
          { agent: "codex", mode: "write", isolation: "inplace", json: true },
          io,
        );
        expect(code).toBe(EXIT_OK);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.status).toBe("succeeded");
        expect(parsed.report.status).toBe("success");
        expect(parsed.report_source).toBe("file");
      }),
    );
  }, 20_000);

  it("I3 (final review): an agent exiting with code 0 but declaring a \"failed\" report does not return a success exit code", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        // "success" mode (default): the process exits with code 0.
        // `status: "failed"` (override of the written report): the agent
        // nevertheless declares a failure. Before I3, exit code and
        // "status: succeeded" only looked at the process — an automation
        // chaining on "caesar run" would have concluded success on this
        // task.
        const code = await runRun(
          root,
          "task whose report says failure despite an exit 0",
          { agent: "codex", mode: "write", isolation: "inplace", context: JSON.stringify({ status: "failed" }), json: true },
          io,
        );
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.status).toBe("succeeded"); // the process, for its part, did succeed.
        expect(parsed.report.status).toBe("failed"); // but the report says the opposite.
        expect(code).toBe(EXIT_RUNTIME); // and it is that second level that must decide the exit code.
      }),
    );
  }, 20_000);

  it("--channel enables the return channel: the report tier becomes \"channel\" (task 9)", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        const code = await runRun(
          root,
          "write a file, with a channel",
          { agent: "codex", mode: "write", isolation: "inplace", json: true, channel: true },
          io,
        );
        expect(code).toBe(EXIT_OK);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.status).toBe("succeeded");
        // "channel" rather than "file" (compare with the first task of this
        // file, identical without --channel): proof that the flag did reach
        // `runTask` via `RunTaskInput.channel`, and that "codex"
        // (mcpInjection: "flag") supports it.
        expect(parsed.report_source).toBe("channel");
      }),
    );
  }, 20_000);

  it("--json produces nothing but valid JSON on stdout, without ANSI", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        const code = await runRun(root, "task", { agent: "codex", mode: "write", isolation: "inplace", json: true }, io);
        expect(code).toBe(EXIT_OK);
        expect(() => JSON.parse(io.stdoutText())).not.toThrow();
        expect(io.stdoutText()).not.toMatch(/\x1b\[/);
        expect(io.stderrText()).toBe("");
      }),
    );
  }, 20_000);

  it("--isolation inplace for writes in a git repository: refused, launching nothing and leaving nothing behind", async () => {
    // The original defect, seen from the CLI: without this refusal, the
    // agent wrote on the user's current working branch, and only the
    // repository's content revealed it after the fact. The refusal falls in
    // `resolveDelegation`, hence before any task directory and any
    // subprocess.
    await withFakeHome(async () => {
      await initGitRepo(root);
      const code = await runRun(root, "task", { agent: "codex", mode: "write", isolation: "inplace" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/refused/);
      // The reason must send toward the workshop before the opt-in: the
      // worktree is the way out, the opt-in the derogation.
      expect(io.stderrText()).toMatch(/\[worktree\]/);
      expect(io.stderrText()).toMatch(/allow_inplace_write/);
      await expect(readFile(join(root, ".caesar", "tasks"), "utf8")).rejects.toThrow();
    });
  });

  it("--isolation inplace for writes outside a git repository: accepted, no worktree being possible there", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const code = await runRun(root, "task", { agent: "codex", mode: "write", isolation: "inplace", json: true }, io);
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);

  it("an agent denied by the policy exits with code 2 with the reason rendered by @caesar/core, word for word", async () => {
    await withFakeHome(async () => {
      await runPolicyDeny(root, "codex", {}, makeIo());
      const code = await runRun(root, "task", { agent: "codex" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText().trim()).toBe(
        'Agent "codex" refused: present in the policy\'s "denied" list.',
      );
    });
  });

  it("unknown --role: usage code, clear message", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "task", { role: "nonexistent" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/nonexistent/);
    });
  });

  it("neither --agent nor --role: usage code, message naming both flags", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "task", {}, io);
      expect(code).toBe(EXIT_USAGE);
      // Message specific to the CLI (names the flags), not the generic
      // reason `resolveDelegation` renders for its other callers (see the
      // task 7 correction report — lost silently during the extraction,
      // restored by the review).
      expect(io.stderrText().trim()).toBe("Specify --agent <id> or --role <name>.");
    });
  });

  it("an invalid --mode wins over an unknown --role: shape validation exits before any resolution", async () => {
    await withFakeHome(async () => {
      // Pins the precedence ratified by the task 7 review: shape
      // validations (--mode, --isolation), which require no I/O, exit
      // before even attempting to resolve --role — whether or not it is
      // valid. Before the extraction of `resolveDelegation`, the reverse
      // order would have rendered "Unknown role" here; this test would have
      // caught the precedence regression flagged in review.
      const code = await runRun(root, "task", { role: "nonexistent", mode: "bogus" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--mode/);
      expect(io.stderrText()).not.toMatch(/nonexistent/);
      expect(io.stderrText()).not.toMatch(/[Uu]nknown role/);
    });
  });

  it("--agent unknown to the catalog: usage code", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "task", { agent: "ghost-agent" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/[Uu]nknown/);
    });
  });

  it("invalid --mode: usage code, without launching anything", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "task", { agent: "codex", mode: "readonly" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--mode/);
    });
  });

  it("invalid --isolation: usage code", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "task", { agent: "codex", isolation: "bogus" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--isolation/);
    });
  });

  it("invalid --timeout: usage code with the parseDuration message", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "task", { agent: "codex", timeout: "3 fortnights" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/Invalid duration/);
    });
  });

  it("an agent that fails (non-zero exit) makes the command exit with code 1", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        const code = await runRun(
          root,
          "task",
          { agent: "codex", mode: "write", isolation: "inplace", json: true, context: JSON.stringify({ mode: "fail" }) },
          io,
        );
        expect(code).toBe(EXIT_RUNTIME);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.status).toBe("failed");
      }),
    );
  }, 20_000);

  it("--context @file reads the designated file", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        const contextFile = join(root, "context.txt");
        await writeFile(contextFile, JSON.stringify({ summary: "from a file" }), "utf8");

        const code = await runRun(
          root,
          "task",
          { agent: "codex", mode: "write", isolation: "inplace", json: true, context: `@${contextFile}` },
          io,
        );
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);

  it("progress (human mode) is emitted during execution, not merely re-read at the end", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        let settled = false;
        const runPromise = runRun(
          root,
          "task followed live",
          { agent: "codex", mode: "write", isolation: "inplace", context: JSON.stringify({ mode: "hang", sleepMs: 500 }) },
          io,
        ).then((code) => {
          settled = true;
          return code;
        });

        // The "start" line (derived from the "started" event) must appear
        // while `runRun` is still executing — that is what distinguishes a
        // live display (onEvent) from an after-the-fact re-read.
        for (let i = 0; i < 100 && !io.stdoutText().includes("start"); i++) {
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
        }
        expect(io.stdoutText()).toContain("start");
        expect(settled).toBe(false);

        const code = await runPromise;
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);

  it("SIGINT cleanly interrupts a running task, leaving no child process behind", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async (shimDir) => {
        await initGitRepoAllowingInplaceWrite(root);
        const shimPath = join(shimDir, "codex");

        const runPromise = runRun(
          root,
          "interrupted task",
          { agent: "codex", mode: "write", isolation: "inplace", context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }) },
          io,
        );

        for (let i = 0; i < 100 && !io.stdoutText().includes("start"); i++) {
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
        }
        expect(io.stdoutText()).toContain("start");

        // `process.emit` directly invokes the handlers registered via
        // `process.on("SIGINT", ...)`, without going through the real OS
        // signal — we exercise exactly the same code Ctrl-C would trigger,
        // without risking affecting the test process itself or other test
        // files running in parallel.
        process.emit("SIGINT", "SIGINT");

        // Proof that the signal really reached and terminated the
        // subprocess, well before `sleepMs`'s 30 s.
        const code = await runPromise;
        expect(code).toBe(EXIT_RUNTIME);
        expect(io.stderrText()).toMatch(/Interruption requested/);

        try {
          const { stdout } = await execFileAsync("pgrep", ["-f", shimPath]);
          expect(stdout.trim()).toBe("");
        } catch (error) {
          // pgrep exits with an error (code 1) when nothing matches: that is the expected result.
          expect((error as { code?: number }).code).toBe(1);
        }
      }),
    );
  }, 20_000);

  /**
   * Seam tests (final review) for C1 and C4 — see also
   * `packages/core/src/engine/runner.test.ts` (`describe("seam tests — final review"`)
   * for C2/C3, and `packages/core/src/delegation.test.ts` (`describe("nextDelegationDepth"`)
   * for the depth-computation unit that the second test below wires end to
   * end. `FAKE_AGENT_PATH` (never a real agent CLI) is used directly as the
   * `bin` of an `[[agent]]` — not via `withFakeAgentAsBin`, which would
   * mask an identifier of the native catalog rather than declare a new one.
   */
  it("C1: an agent declared in [[agent]] (.caesar/config.toml) runs end to end via \"caesar run\"", async () => {
    await withFakeHome(async () => {
      // Literally reproduces the C1 repro from the final review:
      // `caesar run --agent my-bash-agent` used to answer "Unknown agent"
      // (exit 2), even though the configuration was properly read.
      await mkdir(join(root, ".caesar"), { recursive: true });
      const toml = [
        "[[agent]]",
        'id = "my-bash-agent"',
        `bin = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(FAKE_AGENT_PATH)}, "{{prompt}}"]`,
        "",
      ].join("\n");
      await writeFile(join(root, ".caesar", "config.toml"), toml, "utf8");

      const code = await runRun(
        root,
        "create hello.txt",
        { agent: "my-bash-agent", mode: "write", isolation: "inplace", json: true },
        io,
      );

      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.status).toBe("succeeded");
      expect(parsed.report.status).toBe("success");
    });
  }, 20_000);

  it("C4: a depth inherited from $CAESAR_DEPTH reaching max_depth refuses the delegation", async () => {
    await withFakeHome(async () => {
      // policy.max_depth is 2 by default (config.ts, DEFAULT_POLICY).
      // $CAESAR_DEPTH="1" simulates a `caesar run` itself running as the
      // sub-agent of a depth-1 delegation: the next delegation would thus
      // be of depth 2, which reaches max_depth exactly — and must be
      // refused (isDepthAllowed: depth >= max_depth). Before C4 of the
      // final review, nobody re-read this variable: the refusal did not
      // exist, whatever the inherited depth.
      const previous = process.env[ENV.depth];
      process.env[ENV.depth] = "1";
      try {
        const code = await runRun(root, "objective at an excessive depth", { agent: "codex", mode: "read-only", json: true }, io);
        expect(code).toBe(EXIT_USAGE);
        expect(io.stderrText()).toMatch(/max_depth/);
      } finally {
        if (previous === undefined) delete process.env[ENV.depth];
        else process.env[ENV.depth] = previous;
      }
    });
  });

  it("refuses a delegation requiring the network when the agent cannot provide it", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "install a dependency", { agent: "codex", mode: "read-only", network: "on", json: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toContain("--mode write");
    });
  });

  it("refuses a --network value outside the three expected ones, before any resolution", async () => {
    const code = await runRun(root, "objective", { agent: "codex", network: "maybe" }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/Invalid --network/);
  });

  it("passes the raw arguments to the agent's CLI, at the end of the command line", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepoAllowingInplaceWrite(root);
        const code = await runRun(
          root,
          "objective",
          { agent: "codex", mode: "write", isolation: "inplace", extraArgs: ["--enable", "feature_x"], json: true },
          io,
        );
        expect(code).toBe(EXIT_OK);
        // The `started` event publishes the full command line: it is the
        // proof that the argument really reached the subprocess, and not
        // only the `RunTaskInput`.
        const taskId = JSON.parse(io.stdoutText()).task_id as string;
        const events = await readFile(join(root, ".caesar", "tasks", taskId, "events.jsonl"), "utf8");
        const started = events
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { type: string; command?: string })
          .find((event) => event.type === "started");
        expect(started?.command).toContain("--enable feature_x");
      }),
    );
  }, 20_000);
});

describe("caesar run — raw arguments and the \"--\" separator", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-dashdash-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses excess operands without the separator — a typo stays a typo", async () => {
    // Commander already refused `caesar run "obj" typo` ("too many
    // arguments"); the variadic argument collecting what follows "--" would
    // have removed that refusal without this guard.
    const code = await runCli(["node", "caesar", "run", "--root", root, "objective", "typo"], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toContain('"--"');
    expect(io.stderrText()).toContain("typo");
  });

  it("lets the same arguments through as soon as they follow the separator", async () => {
    // Without an installed agent, the delegation fails further along — but
    // no longer on the shape guard: the message no longer speaks of the
    // separator.
    const code = await runCli(["node", "caesar", "run", "--root", root, "--agent", "absent-agent", "objective", "--", "typo"], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).not.toContain('"--"');
  });
});

/**
 * The live display, exercised directly: the tests' fake agent does not emit
 * lines in a real CLI's format, so no end-to-end test would go through
 * these branches.
 */
describe("caesar run — the displayed progress", () => {
  function ev(partial: Omit<CaesarEventInput, "protocol" | "seq" | "at" | "task_id">) {
    return EventSchema.parse({ protocol: "caesar.event/v1", seq: 0, at: "2026-08-11T14:00:00.000Z", task_id: "t", ...partial });
  }

  /** The line as it gets written, on a colorless stream. */
  function renderLine(partial: Omit<CaesarEventInput, "protocol" | "seq" | "at" | "task_id">): string | undefined {
    const line = describeEvent(ev(partial));
    return line ? formatEventLine(line, makeIo()) : undefined;
  }

  it("finally shows what the agent says", () => {
    // Written to `events.jsonl` since forever, displayed nowhere: on a task
    // that thinks for a long time between two tools, it was the only thing
    // to see.
    expect(renderLine({ type: "message", text: "I reread the parser." })).toBe("  » agent      I reread the parser.");
    expect(renderLine({ type: "thinking", text: "Let us see\nthe three layers." })).toBe("  · thinking   Let us see the three layers.");
  });

  it("reads a report's summary rather than dumping its JSON", () => {
    const report = JSON.stringify({ protocol: "caesar.report/v1", status: "partial", summary: "I create the three files." });
    expect(renderLine({ type: "message", text: report })).toBe("  » agent      I create the three files.");
  });

  it("announces a tool from its start, and names its anonymous closing", () => {
    expect(renderLine({ type: "tool_use", tool: "shell", id: "i1", input_summary: "npm test", status: "started" })).toBe(
      "  ▸ tool       shell — npm test (started)",
    );
    // A tool's closing with claude only carries the call identifier.
    expect(renderLine({ type: "tool_use", tool: "", id: "toolu_1", input_summary: "", status: "succeeded" })).toBe(
      "  ▸ tool       (end) (succeeded)",
    );
  });

  it("aligns the texts, whatever the label", () => {
    // That is the whole point of the fixed-width label: the column scans at
    // a glance, where `[tool]`/`[thinking]` shifted every line.
    const column = (line: string): number => line.indexOf(line.trim().split(/\s{2,}/)[1] ?? "");
    const toolLine = renderLine({ type: "tool_use", tool: "shell", id: "i", input_summary: "x", status: "started" }) ?? "";
    const thinkingLine = renderLine({ type: "thinking", text: "y" }) ?? "";
    expect(column(toolLine)).toBe(column(thinkingLine));
  });

  it("the mark carries the color, never the agent's speech", () => {
    const io = makeIo();
    (io.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const previous = process.env["NO_COLOR"];
    delete process.env["NO_COLOR"];
    try {
      const line = describeEvent(ev({ type: "message", text: "A sentence." }));
      const rendered = formatEventLine(line!, io);
      expect(rendered).toMatch(/\x1b\[/);
      // The text itself comes after the last RESET: it inherits the
      // terminal's foreground, so it stays readable on light and dark
      // backgrounds alike.
      expect(rendered.slice(rendered.lastIndexOf("\x1b[0m") + 4)).toBe(" A sentence.");
    } finally {
      if (previous !== undefined) process.env["NO_COLOR"] = previous;
    }
  });
});
