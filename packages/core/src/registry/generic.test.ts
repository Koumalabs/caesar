import { describe, expect, it } from "vitest";
import {
  createGenericAgent,
  formatArgTemplate,
  splitArgTemplate,
  validateGenericAgentSpec,
} from "./generic.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const { sampleTask, sampleContext } = makeSampleFactory("my-cli");

describe("createGenericAgent", () => {
  it("uses the identifier as the default display name", () => {
    const agent = createGenericAgent({ id: "my-cli", bin: "my-cli", args: [] });
    expect(agent.displayName).toBe("my-cli");
  });

  it("substitutes the known tokens", () => {
    const agent = createGenericAgent({
      id: "my-cli",
      bin: "my-cli",
      args: ["run", "--workspace={{workspace}}", "--task-dir={{taskDir}}", "--report={{reportPath}}", "{{prompt}}"],
    });
    const plan = agent.build(sampleContext());
    expect(plan.args).toEqual([
      "run",
      "--workspace=/tmp/wt",
      "--task-dir=/tmp/task",
      "--report=/tmp/task/report.json",
      "PROMPT",
    ]);
  });

  it("makes the entire argument whose token has no value disappear", () => {
    const agent = createGenericAgent({
      id: "my-cli",
      bin: "my-cli",
      args: ["run", "--model={{model}}", "{{prompt}}"],
    });
    const withoutModel = agent.build(sampleContext());
    expect(withoutModel.args).toEqual(["run", "PROMPT"]);

    const withModel = agent.build(sampleContext({ model: "gpt-5" }));
    expect(withModel.args).toEqual(["run", "--model=gpt-5", "PROMPT"]);
  });

  it("appends the raw arguments after the template arguments", () => {
    const agent = createGenericAgent({ id: "my-cli", bin: "my-cli", args: ["{{prompt}}"] });
    const plan = agent.build(sampleContext({ extraArgs: ["--verbose"] }));
    expect(plan.args).toEqual(["PROMPT", "--verbose"]);
  });

  it("carries the workspace through the cwd in process mode (the default)", () => {
    const agent = createGenericAgent({ id: "my-cli", bin: "my-cli", args: [] });
    const plan = agent.build(sampleContext());
    expect(plan.cwd).toBe("/tmp/wt");
  });

  it("does not duplicate the workspace onto the cwd in flag mode", () => {
    const agent = createGenericAgent({
      id: "my-cli",
      bin: "my-cli",
      args: ["--dir={{workspace}}"],
      cwdMode: "flag",
    });
    const plan = agent.build(sampleContext());
    expect(plan.cwd).toBe(paths.dir);
  });

  it("neutral values for unspecified capabilities, mcpInjection at none", () => {
    const agent = createGenericAgent({ id: "my-cli", bin: "my-cli", args: [] });
    expect(agent.capabilities).toEqual({
      jsonEvents: false,
      outputSchema: false,
      finalMessageFile: false,
      nativeReadOnly: false,
      resume: false,
      addDir: false,
      mcpInjection: "none",
      model: false,
      // "unknown", and not "closed": without `networkArgs`, the orchestrator
      // has no idea what this CLI does with the network.
      network: "unknown",
    });
  });

  it("declared network arguments move the capability to \"toggle\"", () => {
    const agent = createGenericAgent({
      id: "my-cli",
      bin: "my-cli",
      args: ["{{prompt}}"],
      networkArgs: ["--online"],
    });
    expect(agent.capabilities.network).toBe("toggle");
  });

  it("only adds the network arguments when the task is entitled to the network", () => {
    const agent = createGenericAgent({
      id: "my-cli",
      bin: "my-cli",
      args: ["{{prompt}}"],
      networkArgs: ["--online"],
    });
    expect(agent.build(sampleContext({ task: sampleTask({ network: true }) })).args).toContain("--online");
    expect(agent.build(sampleContext({ task: sampleTask({ network: false }) })).args).not.toContain("--online");
  });

  it("refuses an unknown token even in the network arguments", () => {
    // Without this check, the typo would make the whole argument disappear
    // (see `substitute`): the agent would depart without network while
    // announcing "network toggleable".
    const error = validateGenericAgentSpec({
      id: "my-cli",
      bin: "my-cli",
      args: ["{{prompt}}"],
      networkArgs: ["--proxy={{prxy}}"],
    });
    expect(error).toContain("{{prxy}}");
  });

  it("settles for the file tier even when a channel is available (mcpInjection none)", () => {
    const agent = createGenericAgent({ id: "my-cli", bin: "my-cli", args: [] });
    expect(agent.preferredReportChannel(sampleTask(), true)).toBe("file");
  });

  it("honors explicitly provided capabilities", () => {
    const agent = createGenericAgent({
      id: "my-cli",
      bin: "my-cli",
      args: [],
      capabilities: { outputSchema: true },
    });
    expect(agent.preferredReportChannel(sampleTask(), false)).toBe("schema");
  });

  it("never translates anything: the output format of a generic CLI is unknown", () => {
    const agent = createGenericAgent({ id: "my-cli", bin: "my-cli", args: [] });
    expect(agent.translate('{"type":"message","text":"hi"}')).toEqual({ events: [] });
    expect(agent.translate("")).toEqual({ events: [] });
  });

  it("places the provided bin as the plan's command", () => {
    const agent = createGenericAgent({ id: "my-cli", bin: "/usr/local/bin/my-cli", args: [] });
    const plan = agent.build(sampleContext());
    expect(plan.command).toBe("/usr/local/bin/my-cli");
  });

  it("deduces the \"model\" capability from the presence of {{model}} in the arguments", () => {
    // Nothing else carries model choice for a generic agent: the
    // capability announced by `caesar agents list` must follow the arguments,
    // not a checkbox next to them.
    expect(createGenericAgent({ id: "a", bin: "a", args: ["{{prompt}}"] }).capabilities.model).toBe(false);
    expect(createGenericAgent({ id: "a", bin: "a", args: ["--model", "{{model}}", "{{prompt}}"] }).capabilities.model).toBe(true);
  });

  it("an explicitly provided capability wins over the deduction", () => {
    const agent = createGenericAgent({ id: "a", bin: "a", args: ["--model={{model}}"], capabilities: { model: false } });
    expect(agent.capabilities.model).toBe(false);
  });

  it("an unknown token makes its argument disappear, like a known token without a value", () => {
    // The behavior `validateGenericAgentSpec` exists to prevent:
    // without it, a typo silently removes the argument.
    const agent = createGenericAgent({ id: "a", bin: "a", args: ["--message", "{{promt}}"] });
    expect(agent.build(sampleContext()).args).toEqual(["--message"]);
  });
});

describe("splitArgTemplate", () => {
  it("splits on whitespace", () => {
    expect(splitArgTemplate("exec --json {{prompt}}")).toEqual(["exec", "--json", "{{prompt}}"]);
  });

  it("honors double and single quotes", () => {
    expect(splitArgTemplate('--system "you are {{prompt}}"')).toEqual(["--system", "you are {{prompt}}"]);
    expect(splitArgTemplate("--system 'two words'")).toEqual(["--system", "two words"]);
  });

  it("keeps an explicitly written empty argument", () => {
    expect(splitArgTemplate('--flag "" {{prompt}}')).toEqual(["--flag", "", "{{prompt}}"]);
  });

  it("ignores multiple spaces and the edges", () => {
    expect(splitArgTemplate("   exec    {{prompt}}  ")).toEqual(["exec", "{{prompt}}"]);
    expect(splitArgTemplate("")).toEqual([]);
    expect(splitArgTemplate("   ")).toEqual([]);
  });

  it("glues segments adjoining a quoted group", () => {
    expect(splitArgTemplate('--msg="{{prompt}} !"')).toEqual(["--msg={{prompt}} !"]);
  });

  it("throws on an unclosed quote rather than returning an amputated argument", () => {
    expect(() => splitArgTemplate('--system "you are')).toThrow(/Unclosed/);
  });
});

describe("formatArgTemplate", () => {
  it("quotes only what needs it", () => {
    expect(formatArgTemplate(["exec", "--json", "{{prompt}}"])).toBe("exec --json {{prompt}}");
    expect(formatArgTemplate(["--system", "you are {{prompt}}"])).toBe('--system "you are {{prompt}}"');
    expect(formatArgTemplate([""])).toBe('""');
  });

  it("picks the single quote when the argument contains a double quote", () => {
    expect(formatArgTemplate(['say "hi"'])).toBe(`'say "hi"'`);
  });

  it("round-trips with splitArgTemplate", () => {
    for (const args of [["exec", "--json", "{{prompt}}"], ["--system", "you are {{prompt}}"], ["--flag", "", "x"], ['say "hi"']]) {
      expect(splitArgTemplate(formatArgTemplate(args))).toEqual(args);
    }
  });
});

describe("validateGenericAgentSpec", () => {
  const ok = { id: "aider", bin: "aider", args: ["--message", "{{prompt}}"] };

  it("accepts a usable declaration", () => {
    expect(validateGenericAgentSpec(ok)).toBeNull();
  });

  it("refuses an empty or exotic identifier", () => {
    expect(validateGenericAgentSpec({ ...ok, id: "" })).toMatch(/cannot be empty/);
    expect(validateGenericAgentSpec({ ...ok, id: "my agent" })).toMatch(/Invalid/);
    expect(validateGenericAgentSpec({ ...ok, id: "-agent" })).toMatch(/Invalid/);
  });

  it("refuses an empty binary", () => {
    expect(validateGenericAgentSpec({ ...ok, bin: "  " })).toMatch(/has no binary/);
  });

  it("names the unknown token and recalls the known tokens", () => {
    const error = validateGenericAgentSpec({ ...ok, args: ["--message", "{{promt}}"] });
    expect(error).toMatch(/\{\{promt\}\}/);
    expect(error).toMatch(/\{\{prompt\}\}/);
    expect(error).toMatch(/disappears entirely/);
  });

  it("refuses a template that never passes on the objective", () => {
    expect(validateGenericAgentSpec({ ...ok, args: ["exec", "--json"] })).toMatch(/task's objective/);
  });

  it("accepts {{prompt}} glued to other tokens or to text", () => {
    expect(validateGenericAgentSpec({ ...ok, args: ["--msg={{prompt}}"] })).toBeNull();
  });
});
