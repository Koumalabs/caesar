import { describe, expect, it } from "vitest";
import { materializationNotice, resolveScope, scopeFlagHint, scopeLabel } from "./scope.js";

describe("resolveScope", () => {
  it("without an option: project layer (behavior from before task 13)", () => {
    expect(resolveScope({})).toBe("project");
  });

  it("--global alone: global layer", () => {
    expect(resolveScope({ global: true })).toBe("global");
  });

  it("--local alone: local layer", () => {
    expect(resolveScope({ local: true })).toBe("local");
  });

  it("--global and --local together: explicit error, neither wins silently", () => {
    const result = resolveScope({ global: true, local: true });
    expect(typeof result).not.toBe("string");
    expect((result as { error: string }).error).toMatch(/--global/);
    expect((result as { error: string }).error).toMatch(/--local/);
    expect((result as { error: string }).error).toMatch(/mutually exclusive/);
  });

  it("--global/--local explicitly false (commander without the flag): project layer, no error", () => {
    expect(resolveScope({ global: false, local: false })).toBe("project");
  });
});

describe("scopeLabel", () => {
  it("names each layer's file", () => {
    expect(scopeLabel("global")).toContain("~/.config/caesar/config.toml");
    expect(scopeLabel("project")).toContain(".caesar/config.toml");
    expect(scopeLabel("local")).toContain(".caesar/config.local.toml");
  });
});

describe("scopeFlagHint", () => {
  it("gives the flag to use to explicitly target the layer", () => {
    expect(scopeFlagHint("global")).toBe("--global");
    expect(scopeFlagHint("local")).toBe("--local");
    expect(scopeFlagHint("project")).toMatch(/without --global or --local/);
  });
});

describe("materializationNotice", () => {
  it("names the field, the layer, and the effective value now materialized", () => {
    const message = materializationNotice("denied", "project", ["copilot", "opencode"]);
    expect(message).toContain('"denied"');
    expect(message).toContain("project");
    expect(message).toContain("copilot, opencode");
  });

  it("empty list: says it explicitly rather than rendering an empty parenthesis", () => {
    const message = materializationNotice("allowed", "local", []);
    expect(message).toContain("empty");
  });
});
