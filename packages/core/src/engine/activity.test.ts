import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CaesarEvent, CaesarEventInput } from "@caesar/protocol";
import { EventSchema } from "@caesar/protocol";
import { codexAgent } from "../adapters/codex.js";
import { claudeAgent } from "../adapters/claude.js";
import { describeActivity, emptyActivity, foldActivity, formatDuration, STALL_MS } from "./activity.js";
import type { ActivityState } from "./activity.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const T0 = Date.parse("2026-08-11T14:00:00.000Z");

/** A complete event, dated at `T0 + offsetMs`. */
function event(offsetMs: number, partial: Omit<CaesarEventInput, "protocol" | "seq" | "at" | "task_id">): CaesarEvent {
  return EventSchema.parse({
    protocol: "caesar.event/v1",
    seq: 0,
    at: new Date(T0 + offsetMs).toISOString(),
    task_id: "t_test",
    ...partial,
  });
}

function fold(...events: CaesarEvent[]): ActivityState {
  return events.reduce(foldActivity, emptyActivity());
}

describe("foldActivity — tools", () => {
  it("holds the tool open between its start and its end", () => {
    const open = fold(event(0, { type: "tool_use", tool: "shell", id: "item_1", input_summary: "npm test", status: "started" }));
    expect(open.runningTools).toHaveLength(1);
    expect(open.runningTools[0]).toMatchObject({ tool: "shell", summary: "npm test" });

    const closed = foldActivity(
      open,
      event(5_000, { type: "tool_use", tool: "shell", id: "item_1", input_summary: "npm test", status: "succeeded" }),
    );
    expect(closed.runningTools).toEqual([]);
    expect(closed.lastTool).toEqual({ tool: "shell", summary: "npm test", ok: true });
  });

  it("closes the right call when the same command runs twice", () => {
    // The case that matching on (name, summary) alone cannot settle:
    // two simultaneous `ls`, only one of which finishes.
    const state = fold(
      event(0, { type: "tool_use", tool: "shell", id: "a", input_summary: "ls", status: "started" }),
      event(1_000, { type: "tool_use", tool: "shell", id: "b", input_summary: "ls", status: "started" }),
      event(2_000, { type: "tool_use", tool: "shell", id: "b", input_summary: "ls", status: "succeeded" }),
    );
    expect(state.runningTools).toHaveLength(1);
    expect(state.runningTools[0]?.id).toBe("a");
  });

  it("closes a tool whose end carries only the identifier — the case of claude", () => {
    const state = fold(
      event(0, { type: "tool_use", tool: "Bash", id: "toolu_1", input_summary: "ls -1", status: "started" }),
      event(3_000, { type: "tool_use", tool: "", id: "toolu_1", input_summary: "", status: "succeeded" }),
    );
    expect(state.runningTools).toEqual([]);
    // The name and summary come from the opening: the closing does not carry them.
    expect(state.lastTool).toEqual({ tool: "Bash", summary: "ls -1", ok: true });
  });

  it("does not let an end without a start remove a random tool", () => {
    // opencode only reports its tools once finished, never their start.
    const state = fold(event(0, { type: "tool_use", tool: "bash", id: "bash_1", input_summary: "ls -1", status: "succeeded" }));
    expect(state.runningTools).toEqual([]);
    expect(state.lastTool).toEqual({ tool: "bash", summary: "ls -1", ok: true });
  });

  it("caps the number of tools considered open", () => {
    // An adapter that announced starts without ever closing them would
    // otherwise grow this list indefinitely.
    const events = Array.from({ length: 20 }, (_, i) =>
      event(i * 100, { type: "tool_use", tool: "shell", id: `t${i}`, input_summary: `cmd ${i}`, status: "started" }),
    );
    expect(fold(...events).runningTools.length).toBeLessThanOrEqual(8);
  });

  it("forgets the tools still open when the task finishes", () => {
    const state = fold(
      event(0, { type: "tool_use", tool: "shell", id: "a", input_summary: "sleep 99", status: "started" }),
      event(1_000, { type: "finished", status: "success", summary: "", exit_code: 0 }),
    );
    expect(state.runningTools).toEqual([]);
    expect(state.finished).toBe("success");
  });
});

describe("foldActivity — speech", () => {
  it("glues consecutive fragments back together, as antigravity emits them", () => {
    const state = fold(
      event(0, { type: "message", text: "I am looking " }),
      event(100, { type: "message", text: "first at the " }),
      event(200, { type: "message", text: "configuration." }),
    );
    expect(state.speech).toBe("I am looking first at the configuration.");
  });

  it("closes the paragraph as soon as anything else occurs", () => {
    const state = fold(
      event(0, { type: "message", text: "First remark." }),
      event(100, { type: "tool_use", tool: "shell", id: "a", input_summary: "ls", status: "succeeded" }),
      event(200, { type: "message", text: "Second remark." }),
    );
    expect(state.speech).toBe("Second remark.");
  });

  it("keeps only the end of a long monologue", () => {
    const state = fold(...Array.from({ length: 50 }, (_, i) => event(i, { type: "message", text: `sentence ${i}. ` })));
    expect(state.speech.length).toBeLessThanOrEqual(401);
    expect(state.speech.startsWith("…")).toBe(true);
    expect(state.speech.endsWith("sentence 49. ")).toBe(true);
  });

  it("reads a report's summary rather than displaying its JSON — the case of codex", () => {
    // codex does not send prose: each of its `agent_message` is a
    // serialized report. As-is, it is a wall of JSON where a sentence is
    // expected.
    const report = JSON.stringify({ protocol: "caesar.report/v1", status: "partial", summary: "I am creating the requested file." });
    expect(fold(event(0, { type: "message", text: report })).speech).toBe("I am creating the requested file.");
  });

  it("leaves intact a sentence that starts with a brace without being JSON", () => {
    const state = fold(event(0, { type: "message", text: "{this is not JSON" }));
    expect(state.speech).toBe("{this is not JSON");
  });
});

describe("foldActivity — files, errors, progress", () => {
  it("accumulates the touched paths without duplicates, in order", () => {
    const state = fold(
      event(0, { type: "file_changed", path: "a.ts", action: "created" }),
      event(100, { type: "file_changed", path: "b.ts", action: "modified" }),
      event(200, { type: "file_changed", path: "a.ts", action: "modified" }),
    );
    expect(state.filesTouched).toEqual(["a.ts", "b.ts"]);
  });

  it("retains the last error and the last progress", () => {
    const state = fold(
      event(0, { type: "progress", message: "Thinking (~50 tokens)" }),
      event(100, { type: "error", message: "Quota reached.", fatal: true }),
    );
    expect(state.lastProgress).toBe("Thinking (~50 tokens)");
    expect(state.lastError).toBe("Quota reached.");
  });

  it("never modifies the state passed to it", () => {
    const before = emptyActivity();
    const snapshot = JSON.stringify(before);
    foldActivity(before, event(0, { type: "file_changed", path: "a.ts", action: "created" }));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("describeActivity", () => {
  it("prefers a running tool to the last words", () => {
    // "▸ shell npm test, 12s" situates the task; a general sentence does not.
    const state = fold(
      event(0, { type: "message", text: "I am going to run the tests." }),
      event(1_000, { type: "tool_use", tool: "shell", id: "a", input_summary: "npm test", status: "started" }),
    );
    const { headline } = describeActivity(state, T0 + 13_000);
    expect(headline).toBe("▸ shell npm test — 12s");
  });

  it("flags the additional tools rather than showing only one", () => {
    const state = fold(
      event(0, { type: "tool_use", tool: "shell", id: "a", input_summary: "npm test", status: "started" }),
      event(0, { type: "tool_use", tool: "shell", id: "b", input_summary: "npm run lint", status: "started" }),
    );
    expect(describeActivity(state, T0 + 1_000).headline).toContain("(+1)");
  });

  it("returns the speech when nothing is running", () => {
    const state = fold(event(0, { type: "message", text: "I finished reading the parser." }));
    expect(describeActivity(state, T0 + 1_000).headline).toBe("“I finished reading the parser.”");
  });

  it("counts the silence, and flags it beyond the threshold", () => {
    const state = fold(event(0, { type: "message", text: "…" }));
    const short = describeActivity(state, T0 + 5_000);
    expect(short.silentMs).toBe(5_000);
    expect(short.stalled).toBe(false);

    const long = describeActivity(state, T0 + STALL_MS + 1_000);
    expect(long.stalled).toBe(true);
  });

  it("flags no silence on a task where nothing has arrived yet", () => {
    // Without this guard, a task that has just been created would appear
    // mute since 1970.
    const { silentMs, stalled, headline } = describeActivity(emptyActivity(), T0);
    expect(silentMs).toBe(0);
    expect(stalled).toBe(false);
    expect(headline).toBe("no events yet");
  });

  it("announces the end with the status declared by the agent", () => {
    const state = fold(event(0, { type: "finished", status: "partial", summary: "", exit_code: 0 }));
    expect(describeActivity(state, T0 + 1_000).headline).toBe('finished — report "partial"');
  });

  it("puts an error forward when nothing is running anymore", () => {
    const state = fold(
      event(0, { type: "message", text: "I am attempting the install." }),
      event(1_000, { type: "error", message: "Quota reached.", fatal: true }),
    );
    expect(describeActivity(state, T0 + 2_000).headline).toBe("⚠ Quota reached.");
  });
});

describe("formatDuration", () => {
  it("renders a short duration readably", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(47_000)).toBe("47s");
    expect(formatDuration(134_000)).toBe("2m14s");
    expect(formatDuration(3_600_000)).toBe("1h00m");
    expect(formatDuration(-5)).toBe("0s");
  });
});

/**
 * The test that matters: the fold applied to the real captures. A test on
 * hand-crafted events proves the mechanics; this one proves that it renders
 * something sensible on what the agents actually emit.
 */
describe("foldActivity on the real captures", () => {
  function foldFixture(name: string, agent: typeof codexAgent): ActivityState {
    const lines = readFileSync(join(FIXTURE_DIR, name), "utf8").split("\n").filter((l) => l.trim());
    let seq = 0;
    let state = emptyActivity();
    for (const line of lines) {
      for (const partial of agent.translate(line).events) {
        state = foldActivity(state, event(seq * 1_000, partial as never));
        seq += 1;
      }
    }
    return state;
  }

  it("codex: both commands and the written file are rendered", () => {
    const state = foldFixture("codex.jsonl", codexAgent);
    expect(state.filesTouched).toEqual(["/tmp/caesar-capture/note.txt"]);
    // Each command was opened then closed: nothing is left hanging.
    expect(state.runningTools).toEqual([]);
    expect(state.lastTool?.tool).toBe("shell");
    expect(state.finished).toBe("success");
    // The speech is the report's summary, not its JSON.
    expect(state.speech).not.toContain("caesar.report");
  });

  it("claude: the tools pair up despite an anonymous closing", () => {
    const state = foldFixture("claude.jsonl", claudeAgent);
    expect(state.runningTools).toEqual([]);
    expect(state.finished).toBe("success");
    expect(state.lastProgress).toContain("Thinking");
    expect(state.speech).not.toBe("");
  });
});
