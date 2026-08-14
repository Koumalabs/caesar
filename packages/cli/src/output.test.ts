import { afterEach, describe, expect, it } from "vitest";
import { colorize, homePath, printJson, printError, printTable, printWarning, sectionHeader, writeLine } from "./output.js";
import { makeIo, type CapturedIo } from "../test/support.js";

/** A captured stream that presents itself as a terminal, to exercise color. */
function ttyIo(columns?: number): CapturedIo {
  const io = makeIo();
  const stdout = io.stdout as unknown as { isTTY?: boolean; columns?: number };
  stdout.isTTY = true;
  if (columns !== undefined) stdout.columns = columns;
  return io;
}

/** Displayed length: ANSI sequences occupy no column. */
function visibleLength(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["NO_COLOR", "COLORTERM", "TERM", "LC_ALL", "LC_CTYPE", "LANG"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("output", () => {
  it("printJson writes only the JSON, without color, terminated by a newline", () => {
    const io: CapturedIo = makeIo();
    printJson(io, { a: 1, b: [1, 2] });
    expect(io.stdoutText()).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("printError writes to stderr, never to stdout", () => {
    const io: CapturedIo = makeIo();
    printError(io, "something went wrong");
    expect(io.stderrText()).toBe("something went wrong\n");
    expect(io.stdoutText()).toBe("");
  });

  it("printWarning writes to stderr", () => {
    const io: CapturedIo = makeIo();
    printWarning(io, "watch out");
    expect(io.stderrText()).toBe("watch out\n");
  });

  it("colorize never colors a stream without isTTY (the case of tests, and of any pipe)", () => {
    const io: CapturedIo = makeIo();
    expect(colorize("text", "bad", io.stdout)).toBe("text");
  });

  it("colorize honors NO_COLOR even on an isTTY stream", () => {
    const io = ttyIo();
    process.env["NO_COLOR"] = "1";
    expect(colorize("text", "bad", io.stdout)).toBe("text");
  });

  it("colorize renders the theme token, not a named color", () => {
    const io = ttyIo();
    delete process.env["NO_COLOR"];
    process.env["COLORTERM"] = "truecolor";
    // #E88388, the palette's BAD shade — not the base ANSI red.
    expect(colorize("text", "bad", io.stdout)).toBe("\x1b[38;2;232;131;136mtext\x1b[0m");
  });

  it("each stream decides for itself: stdout redirected, stderr on the terminal", () => {
    const io: CapturedIo = makeIo();
    (io.stderr as unknown as { isTTY?: boolean }).isTTY = true;
    delete process.env["NO_COLOR"];
    process.env["COLORTERM"] = "truecolor";
    expect(colorize("text", "bad", io.stdout)).toBe("text");
    expect(colorize("text", "bad", io.stderr)).toMatch(/\x1b\[38;2;/);
  });

  it("writeLine adds a newline", () => {
    const io: CapturedIo = makeIo();
    writeLine(io.stdout, "hello");
    expect(io.stdoutText()).toBe("hello\n");
  });
});

describe("homePath", () => {
  it("replaces the home directory with ~", () => {
    const home = process.env["HOME"] ?? "";
    expect(homePath(`${home}/.local/bin/codex`)).toBe("~/.local/bin/codex");
  });

  it("leaves untouched a path that does not come from it", () => {
    expect(homePath("/usr/local/bin/codex")).toBe("/usr/local/bin/codex");
  });

  it("does not trim a directory that starts with the same name", () => {
    const home = process.env["HOME"] ?? "";
    expect(homePath(`${home}-other/bin`)).toBe(`${home}-other/bin`);
  });
});

describe("sectionHeader", () => {
  it("names the command and fits exactly the terminal width", () => {
    const io = ttyIo(80);
    sectionHeader(io, "doctor");
    const [rule, blank] = io.stdoutText().split("\n");
    expect((rule ?? "").replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/caesar · doctor/);
    expect(visibleLength(rule ?? "")).toBe(80);
    expect(blank).toBe("");
  });

  it("carries no ANSI sequence outside a terminal", () => {
    const io: CapturedIo = makeIo();
    sectionHeader(io, "ps");
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    // The structure, however, remains: it is what a file or a test must see.
    expect(io.stdoutText()).toMatch(/^▞▚ caesar · ps ─+\n\n$/);
  });
});

describe("printTable", () => {
  it("frames the table and aligns the columns", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["id", "name"], [["1", "short"], ["22", "longer text"]], { maxWidth: 80 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("╭────┬─────────────╮");
    expect(lines[1]).toBe("│ id │ name        │");
    expect(lines[2]).toBe("├────┼─────────────┤");
    expect(lines[3]).toBe("│ 1  │ short       │");
    expect(lines[5]).toBe("╰────┴─────────────╯");
  });

  it("never overflows the given width", () => {
    const io: CapturedIo = makeIo();
    const long = "a value far too long for the available space";
    printTable(io, ["a", "b", "c"], [[long, long, long]], { maxWidth: 40 });
    for (const line of io.stdoutText().split("\n").filter(Boolean)) {
      expect(visibleLength(line)).toBeLessThanOrEqual(40);
    }
  });

  it("the frame counts against the budget: the cells lose what it costs", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["a", "b"], [["x".repeat(50), "y".repeat(50)]], { maxWidth: 30 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    // 2 framed columns cost 3×2+1 = 7 characters of chrome.
    expect(lines[0]).toHaveLength(30);
    expect(lines[3]).toMatch(/^│ x+… │ y+… │$/);
  });

  it("gives up the frame rather than breaking it when it cannot fit", () => {
    const io: CapturedIo = makeIo();
    const headers = ["a", "b", "c", "d", "e", "f", "g", "h"];
    printTable(io, headers, [headers.map(() => "avalue")], { maxWidth: 60 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    expect(lines.some((line) => /[╭╮╰╯│┬┴┼]/.test(line))).toBe(false);
    expect(lines[1]).toMatch(/^─+$/);
    // Eight six-character columns: 62 without a frame, 73 with one. The
    // fallback recovers eleven columns, and still overflows by two — that
    // is the inherited contract, assumed in `printTable`: better a table
    // the terminal wraps than a table whose every cell is "…".
    expect(Math.max(...lines.map(visibleLength))).toBe(62);
  });

  it("the fallback stays narrower than the frame it gives up", () => {
    const headers = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const rows = [headers.map(() => "avalue")];
    const narrow = makeIo();
    const large = makeIo();
    printTable(narrow, headers, rows, { maxWidth: 60 });
    printTable(large, headers, rows, { maxWidth: 100 });
    const widest = (io: CapturedIo): number =>
      Math.max(...io.stdoutText().split("\n").filter(Boolean).map(visibleLength));
    expect(widest(narrow)).toBeLessThan(widest(large));
  });

  it("a cell can carry a theme role without the table knowing the domain", () => {
    const io = ttyIo(80);
    delete process.env["NO_COLOR"];
    process.env["COLORTERM"] = "truecolor";
    printTable(io, ["agent", "policy"], [["codex", { text: "allowed", token: "ok" }]]);
    const body = io.stdoutText().split("\n")[3] ?? "";
    expect(body).toMatch(/\x1b\[38;2;125;206;130mallowed\s*\x1b\[0m/);
    // Color is applied after padding: the line keeps its width.
    expect(visibleLength(body)).toBe(visibleLength(io.stdoutText().split("\n")[0] ?? ""));
  });

  it("carries no ANSI sequence outside a terminal, colored cells included", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["agent", "policy"], [["codex", { text: "denied", token: "bad" }]], { maxWidth: 80 });
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    expect(io.stdoutText()).toMatch(/denied/);
  });

  it("falls back to ASCII rules when the locale is not UTF-8", () => {
    const io: CapturedIo = makeIo();
    process.env["LC_ALL"] = "C";
    printTable(io, ["id"], [["1"]], { maxWidth: 80 });
    const lines = io.stdoutText().split("\n").filter(Boolean);
    expect(lines[0]).toBe("+----+");
    expect(lines[1]).toBe("| id |");
    // The fallback keeps exactly the same width as the Unicode drawing.
    expect(lines[0]).toHaveLength(6);
  });

  it("marks the truncation of a trimmed cell", () => {
    const io: CapturedIo = makeIo();
    printTable(io, ["path"], [["/a/really/very/long/path/indeed"]], { maxWidth: 20 });
    expect(io.stdoutText()).toMatch(/…/);
  });
});
