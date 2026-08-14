import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaesarEventInput } from "@caesar/protocol";
import { EventSchema, taskPaths } from "@caesar/protocol";
import { writeQuestion } from "@caesar/mcp-channel";
import type { TaskRecord } from "@caesar/core";
import { fileTaskStore } from "@caesar/core";
import { makeIo, type CapturedIo } from "../../test/support.js";
import { runWatch } from "./watch.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

let root: string;
let io: CapturedIo;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-cli-watch-"));
  io = makeIo();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const id = overrides.id ?? "t_1";
  return {
    id,
    agent: "codex",
    objective: "Reread the configuration parser",
    status: "running",
    created_at: "2026-08-11T10:00:00.000Z",
    started_at: new Date(Date.now() - 5_000).toISOString(),
    task_dir: join(root, ".caesar", "tasks", id),
    workspace: root,
    isolation: "worktree",
    mode: "read-only",
    report_via: "file",
    depth: 0,
    ...overrides,
  };
}

/** Deposits a task in the store and writes its event journal. */
async function plant(
  overrides: Partial<TaskRecord>,
  events: Omit<CaesarEventInput, "protocol" | "seq" | "at" | "task_id">[],
): Promise<TaskRecord> {
  const rec = record(overrides);
  await fileTaskStore(root).create(rec);
  const paths = taskPaths(rec.task_dir);
  await mkdir(paths.dir, { recursive: true });
  const lines = events.map((partial, seq) =>
    JSON.stringify(
      EventSchema.parse({
        protocol: "caesar.event/v1",
        seq,
        at: new Date(Date.now() - (events.length - seq) * 1_000).toISOString(),
        task_id: rec.id,
        ...partial,
      }),
    ),
  );
  await writeFile(paths.eventsPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
  return rec;
}

describe("caesar watch --once", () => {
  it("shows what each task is doing right now", async () => {
    await plant({ id: "t_a", agent: "codex", role: "reviewer" }, [
      { type: "started", agent: "codex", command: "codex exec" },
      { type: "tool_use", tool: "shell", id: "item_1", input_summary: "npm test", status: "started" },
    ]);
    await plant({ id: "t_b", agent: "opencode", objective: "Add a test" }, [
      { type: "started", agent: "opencode", command: "opencode run" },
      { type: "file_changed", path: "src/a.ts", action: "modified" },
      { type: "message", text: "I modified the configuration module." },
    ]);

    expect(await runWatch(root, [], { once: true }, io)).toBe(EXIT_OK);
    const out = io.stdoutText();

    expect(out).toContain("2 active");
    expect(out).toContain("t_a");
    expect(out).toContain("▸ shell npm test");
    expect(out).toContain("t_b");
    expect(out).toContain("“I modified the configuration module.”");
    // The objective always accompanies the task: an identifier alone does
    // not say what one is watching.
    expect(out).toContain("Reread the configuration parser");
    expect(out).toContain("Add a test");
  });

  it("emits no ANSI sequence outside a terminal", async () => {
    // A test's captured output is not a TTY, no more than a redirection to
    // a file: neither color, nor alternate screen, nor screen clearing must
    // slip into it.
    await plant({ id: "t_a" }, [{ type: "started", agent: "codex", command: "codex exec" }]);
    await runWatch(root, [], { once: true }, io);
    // eslint-disable-next-line no-control-regex
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("clearly says there is nothing to see rather than displaying an empty page", async () => {
    expect(await runWatch(root, [], { once: true }, io)).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("No task in progress");
  });

  it("puts a pending question forward, and recalls how to answer it", async () => {
    // This is the state that most resembles a hang without being one: a
    // sub-agent waiting for an answer looks frozen.
    const rec = await plant({ id: "t_q" }, [{ type: "started", agent: "codex", command: "codex exec" }]);
    // Deposited by the channel's function rather than by hand: the exact
    // layout (`<taskDir>/questions/<id>.json`) belongs to
    // `@caesar/mcp-channel`, and a test copying it from memory checks its
    // own assumption.
    await writeQuestion(taskPaths(rec.task_dir).dir, {
      id: "q1",
      question: "Should I delete the obsolete file?",
      options: ["yes", "no"],
      asked_at: new Date().toISOString(),
    });

    await runWatch(root, [], { once: true }, io);
    const out = io.stdoutText();
    expect(out).toContain("Should I delete the obsolete file?");
    // The reminder names the MCP tool, the only way to answer today — there
    // is no `caesar answer` command, and inventing one here would send the
    // user straight into a wall.
    expect(out).toContain("caesar_answer");
    expect(out).toContain("q1");
    expect(out).not.toMatch(/caesar answer\b/);
  });

  it("keeps finished tasks on screen, with their report status", async () => {
    // A task that disappears the moment it finishes is a task whose ending
    // will never be known.
    await plant(
      {
        id: "t_end",
        status: "succeeded",
        report_status: "partial",
        ended_at: new Date(Date.now() - 10_000).toISOString(),
      },
      [{ type: "finished", status: "partial", summary: "", exit_code: 0 }],
    );

    await runWatch(root, [], { once: true }, io);
    const out = io.stdoutText();
    expect(out).toContain("Recently finished");
    expect(out).toContain("t_end");
    expect(out).toContain("report partial");
  });

  it("ignores a task finished a long time ago", async () => {
    // Without this bound, opening the window would scroll the whole history.
    await plant(
      { id: "t_old", status: "succeeded", report_status: "success", ended_at: "2026-08-01T10:00:00.000Z" },
      [{ type: "finished", status: "success", summary: "", exit_code: 0 }],
    );
    await runWatch(root, [], { once: true }, io);
    expect(io.stdoutText()).not.toContain("t_old");
  });

  it("restricts itself to the requested identifiers", async () => {
    await plant({ id: "t_a" }, [{ type: "started", agent: "codex", command: "c" }]);
    await plant({ id: "t_b" }, [{ type: "started", agent: "codex", command: "c" }]);
    await runWatch(root, ["t_a"], { once: true }, io);
    expect(io.stdoutText()).toContain("t_a");
    expect(io.stdoutText()).not.toContain("t_b");
  });

  it("refuses an unknown identifier instead of watching over nothing", async () => {
    expect(await runWatch(root, ["t_ghost"], { once: true }, io)).toBe(EXIT_USAGE);
    expect(io.stderrText()).toContain("t_ghost");
  });

  it("counts the unreadable lines instead of silencing them", async () => {
    // A monitor that yells on every line becomes unusable; a monitor that
    // swallows them masks a schema mismatch.
    const rec = await plant({ id: "t_x" }, [{ type: "started", agent: "codex", command: "c" }]);
    const paths = taskPaths(rec.task_dir);
    await writeFile(paths.eventsPath, `{"not":"an event"}\nthis is not JSON\n`, { flag: "a" });
    await runWatch(root, [], { once: true }, io);
    expect(io.stdoutText()).toContain("2 unreadable line(s)");
  });

  it("flags a prolonged silence", async () => {
    const rec = await plant({ id: "t_mute" }, []);
    const paths = taskPaths(rec.task_dir);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(
      paths.eventsPath,
      JSON.stringify(
        EventSchema.parse({
          protocol: "caesar.event/v1",
          seq: 0,
          at: new Date(Date.now() - 120_000).toISOString(),
          task_id: "t_mute",
          type: "message",
          text: "I am starting.",
        }),
      ) + "\n",
      "utf8",
    );
    await runWatch(root, [], { once: true }, io);
    expect(io.stdoutText()).toMatch(/silence \d+m\d+s/);
  });
});

describe("caesar watch --json", () => {
  it("renders NDJSON: one event per line, re-readable as-is", async () => {
    await plant({ id: "t_a" }, [
      { type: "started", agent: "codex", command: "codex exec" },
      { type: "tool_use", tool: "shell", id: "item_1", input_summary: "ls", status: "started" },
    ]);

    expect(await runWatch(root, [], { once: true, json: true }, io)).toBe(EXIT_OK);
    const lines = io.stdoutText().split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; task_id: string });
    expect(parsed.map((e) => e.type)).toEqual(["started", "tool_use"]);
    expect(parsed.every((e) => e.task_id === "t_a")).toBe(true);
  });

  it("merges the journals of several tasks into a single stream", async () => {
    await plant({ id: "t_a" }, [{ type: "started", agent: "codex", command: "c" }]);
    await plant({ id: "t_b" }, [{ type: "started", agent: "opencode", command: "c" }]);
    await runWatch(root, [], { once: true, json: true }, io);
    const ids = io.stdoutText().split("\n").filter((l) => l.trim()).map((l) => (JSON.parse(l) as { task_id: string }).task_id);
    expect(new Set(ids)).toEqual(new Set(["t_a", "t_b"]));
  });
});
