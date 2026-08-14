import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";
import { EXIT_OK } from "./output.js";
import { makeIo, type CapturedIo } from "../test/support.js";

/** The help as commander writes it to the configured stream. */
function helpFor(args: readonly string[]): string {
  const io: CapturedIo = makeIo();
  const program = buildProgram(io, { value: EXIT_OK });
  const target = args.reduce<ReturnType<typeof buildProgram> | undefined>(
    (cmd, name) => cmd?.commands.find((c) => c.name() === name),
    program,
  );
  if (!target) throw new Error(`Command not found: ${args.join(" ")}`);
  target.outputHelp();
  return io.stdoutText();
}

describe("caesar --help", () => {
  const help = (): string => helpFor([]);

  it("opens on the wordmark", () => {
    expect(help()).toMatch(/^ ██████╗ █████╗ ███████╗███████╗ █████╗ ██████╗ \n/);
  });

  it("says what the tool is and which agents it drives", () => {
    // The wordmark tagline only carries the version: the program
    // description is what names the agents, and nothing shorter would say
    // it.
    expect(help()).toMatch(/Orchestrator of coding sub-agents/);
    expect(help()).toMatch(/Antigravity, Codex, OpenCode, Copilot,\s+Claude/);
  });

  it("leaves no stock commander label behind", () => {
    const out = help();
    for (const stock of ["Usage:", "Options:", "Commands:", "output the version number", "display help for command"]) {
      expect(out).not.toContain(stock);
    }
  });

  it("groups the commands by usage, not by declaration order", () => {
    const out = help();
    const rank = (title: string): number => out.indexOf(title);
    expect(rank("START")).toBeGreaterThan(-1);
    expect(rank("START")).toBeLessThan(rank("DELEGATE"));
    expect(rank("DELEGATE")).toBeLessThan(rank("FOLLOW"));
    expect(rank("FOLLOW")).toBeLessThan(rank("CONFIGURE"));
    expect(rank("CONFIGURE")).toBeLessThan(rank("INTEGRATE"));
    // `run` is declared after `agents` in `program.ts`: without the
    // grouping, it would appear lower.
    expect(out.indexOf("\n  run ")).toBeLessThan(out.indexOf("\n  agents "));
  });

  it("forgets no visible command", () => {
    const io: CapturedIo = makeIo();
    const program = buildProgram(io, { value: EXIT_OK });
    const out = help();
    for (const sub of program.commands) {
      // `channel` is masked (reached by self-invocation, never typed).
      if (sub.name() === "channel") continue;
      expect(out, `command missing from the help: ${sub.name()}`).toMatch(new RegExp(`\\n  ${sub.name()}\\s`));
    }
  });

  it("names --root and --json, which every command accepts", () => {
    // They are set command by command, hence absent from the program's
    // options: without this explicit addition, the root help did not
    // mention them.
    expect(help()).toMatch(/--root <dir>\s+Project root/);
    expect(help()).toMatch(/--json\s+Machine output/);
  });

  it("carries no ANSI sequence outside a terminal", () => {
    expect(help()).not.toMatch(/\x1b\[/);
  });

  it("wraps the descriptions rather than letting them overflow", () => {
    for (const line of help().split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe("caesar <command> --help", () => {
  it("uses the same presentation as the root help", () => {
    // The help configuration is set before the subcommands are created:
    // configured after, it would only have touched the root and left this
    // one with the stock rendering.
    const out = helpFor(["run"]);
    expect(out).toContain("ARGUMENTS");
    expect(out).toContain("OPTIONS");
    expect(out).not.toContain("Usage:");
    expect(out).not.toContain("display help for command");
  });

  it("opens on the usage line, without the wordmark", () => {
    const out = helpFor(["run"]);
    expect(out).toMatch(/^caesar run \[options\] <objective> \[extra_args\.\.\.\]\n/);
    expect(out).not.toContain("▄▀▀▀▄");
  });

  it("lists a group's subcommands with their full form", () => {
    const out = helpFor(["agents"]);
    expect(out).toContain("COMMANDS");
    expect(out).toMatch(/enable \[options\] <id>/);
  });

  it("always separates an overlong term from its description", () => {
    // `add [options] <id>` fits; a term beyond the column takes its own
    // line — otherwise the description was glued to it.
    for (const line of helpFor(["agents"]).split("\n")) {
      expect(line).not.toMatch(/\]\S/);
      expect(line).not.toMatch(/>\S/);
    }
  });
});
