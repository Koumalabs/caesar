/**
 * The `caesar` help, laid out.
 *
 * It is the front door, and it was the least polished surface: commander
 * rendered its default presentation, with its stock labels ("Usage:",
 * "Options:", "output the version number"), the commands in declaration
 * order, and the descriptions overflowing the terminal width without
 * wrapping.
 *
 * Two commitments hold this version together:
 *
 *  - **Commands are grouped by usage, not by declaration order.** Sixteen
 *    commands in a flat list teach nothing to whoever discovers the tool;
 *    five groups of three tell the order in which they get used.
 *  - **The description is wrapped with a hanging indent.** Without it, the
 *    continuation of a description comes back to column zero and blends
 *    into the next command.
 */
import type { Command, Help } from "commander";
import type { Io } from "./output.js";
import { bannerLines, colorize, terminalWidth, wrapText } from "./output.js";
import { VERSION } from "./version.js";

/**
 * The order in which one encounters the commands, not the one in which they
 * were written.
 *
 * A command missing from this table is not lost: it lands in an "other"
 * group. Forgetting to register a new command must be visible, never make
 * it disappear from the help.
 */
const GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  { title: "start", commands: ["init", "doctor", "config"] },
  { title: "delegate", commands: ["run", "watch"] },
  { title: "follow", commands: ["ps", "logs", "cancel", "diff", "apply", "gc"] },
  { title: "configure", commands: ["agents", "policy", "role"] },
  { title: "integrate", commands: ["mcp", "protocol"] },
];

/** Width of the left column. Beyond it, the term takes its own line and the description follows. */
const TERM_WIDTH = 24;
const INDENT = "  ";

/**
 * A "term + description" entry. The term is colored **after** padding,
 * otherwise the ANSI sequences would count as columns.
 *
 * A term longer than the column takes its own line, and the description is
 * written below it: gluing it to its term produced
 * `[extra_args...]Delegates an objective…`, without even a space.
 */
function entry(term: string, description: string, width: number, io: Io, token: "accent" | "strong" = "accent"): string[] {
  const painted = INDENT + colorize(term.padEnd(TERM_WIDTH), token, io.stdout);
  if (description === "") return [(INDENT + term).trimEnd()];

  const indent = " ".repeat(INDENT.length + TERM_WIDTH);
  const lines = wrapText(description, Math.max(20, width - indent.length)).map((l) => colorize(l, "dim", io.stdout));
  if (term.length >= TERM_WIDTH) {
    return [INDENT + colorize(term, token, io.stdout), ...lines.map((l) => indent + l)];
  }
  return lines.map((line, i) => (i === 0 ? painted + line : indent + line));
}

function title(text: string, io: Io): string {
  return colorize(text.toUpperCase(), "faint", io.stdout);
}

/**
 * The help layout, for the root command as for each subcommand — a single
 * presentation, otherwise `caesar --help` and `caesar run --help` would
 * answer each other in two languages.
 */
export function formatHelp(cmd: Command, helper: Help, io: Io): string {
  const width = terminalWidth(io.stdout);
  const lines: string[] = [];
  const isRoot = cmd.parent === null || cmd.parent === undefined;

  if (isRoot) {
    // The wordmark carries the version; the program description follows, in
    // full — it is the one that names the supported agents, and no shorter
    // tagline would say it.
    lines.push(...bannerLines(io.stdout, `v${VERSION}`), "");
    const description = helper.commandDescription(cmd);
    if (description) lines.push(...wrapText(description, width, INDENT).map((l) => colorize(l, "dim", io.stdout)), "");
  } else {
    lines.push(colorize(helper.commandUsage(cmd), "title", io.stdout), "");
    const description = helper.commandDescription(cmd);
    if (description) lines.push(...wrapText(description, width, INDENT).map((l) => colorize(l, "dim", io.stdout)), "");
  }

  if (isRoot) {
    lines.push(title("usage", io));
    lines.push(...entry("caesar <command> [options]", "", width, io, "strong"));
    lines.push("");
  }

  const arguments_ = helper.visibleArguments(cmd);
  if (arguments_.length > 0) {
    lines.push(title("arguments", io));
    for (const arg of arguments_) {
      lines.push(...entry(helper.argumentTerm(arg), helper.argumentDescription(arg), width, io, "strong"));
    }
    lines.push("");
  }

  const commands = helper.visibleCommands(cmd);
  if (commands.length > 0) {
    const remaining = new Map(commands.map((sub) => [sub.name(), sub]));
    // At the root, the name alone: `[options]` appears on each of the
    // sixteen commands, so it distinguishes none, and the arguments are
    // detailed by `caesar <command> --help`. In a subgroup (`caesar agents
    // --help`), the full term takes its place back — there are three
    // entries then, and their shape is what one comes to read.
    const term = (sub: Command): string => (isRoot ? sub.name() : helper.subcommandTerm(sub));
    const render = (heading: string, subs: readonly Command[]): void => {
      if (subs.length === 0) return;
      lines.push(title(heading, io));
      for (const sub of subs) {
        lines.push(...entry(term(sub), helper.subcommandDescription(sub), width, io));
      }
      lines.push("");
    };

    if (isRoot) {
      for (const group of GROUPS) {
        const subs = group.commands.map((name) => remaining.get(name)).filter((c): c is Command => c !== undefined);
        for (const sub of subs) remaining.delete(sub.name());
        render(group.title, subs);
      }
      // What was not classified — a new command, most of the time.
      render("other", [...remaining.values()].filter((sub) => sub.name() !== "help"));
      const help = remaining.get("help");
      if (help) render("help", [help]);
    } else {
      render("commands", commands);
    }
  }

  const options = helper.visibleOptions(cmd);
  if (options.length > 0) {
    lines.push(title("options", io));
    for (const option of options) {
      lines.push(...entry(helper.optionTerm(option), helper.optionDescription(option), width, io, "strong"));
    }
    if (isRoot) {
      // `--root` and `--json` are set command by command
      // (`withCommonOptions`), so absent from the program's options: filing
      // them under a "common options" heading would have implied they
      // appeared in the list above.
      lines.push(...entry("--root <dir>", "Project root. Accepted by every command.", width, io, "strong"));
      lines.push(...entry("--json", "Machine output, without color or formatting. Accepted by every command.", width, io, "strong"));
    }
    lines.push("");
  }

  if (isRoot) {
    lines.push(colorize('  "caesar <command> --help" for the details of a command.', "dim", io.stdout));
    lines.push("");
  }

  // A single trailing blank line, whatever the number of sections rendered.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}
