import { describe, expect, it } from "vitest";
import { materializationNotice, resolveScope, scopeFlagHint, scopeLabel } from "./scope.js";

describe("resolveScope", () => {
  it("sans option : couche projet (comportement d'avant la tâche 13)", () => {
    expect(resolveScope({})).toBe("project");
  });

  it("--global seul : couche globale", () => {
    expect(resolveScope({ global: true })).toBe("global");
  });

  it("--local seul : couche locale", () => {
    expect(resolveScope({ local: true })).toBe("local");
  });

  it("--global et --local ensemble : erreur explicite, ni l'un ni l'autre ne l'emporte en silence", () => {
    const result = resolveScope({ global: true, local: true });
    expect(typeof result).not.toBe("string");
    expect((result as { error: string }).error).toMatch(/--global/);
    expect((result as { error: string }).error).toMatch(/--local/);
    expect((result as { error: string }).error).toMatch(/mutuellement exclusifs/);
  });

  it("--global/--local à false explicitement (commander sans le flag) : couche projet, pas d'erreur", () => {
    expect(resolveScope({ global: false, local: false })).toBe("project");
  });
});

describe("scopeLabel", () => {
  it("nomme le fichier de chaque couche", () => {
    expect(scopeLabel("global")).toContain("~/.config/caesar/config.toml");
    expect(scopeLabel("project")).toContain(".caesar/config.toml");
    expect(scopeLabel("local")).toContain(".caesar/config.local.toml");
  });
});

describe("scopeFlagHint", () => {
  it("donne le flag à utiliser pour cibler explicitement la couche", () => {
    expect(scopeFlagHint("global")).toBe("--global");
    expect(scopeFlagHint("local")).toBe("--local");
    expect(scopeFlagHint("project")).toMatch(/sans --global ni --local/);
  });
});

describe("materializationNotice", () => {
  it("nomme le champ, la couche, et la valeur effective désormais matérialisée", () => {
    const message = materializationNotice("denied", "project", ["copilot", "opencode"]);
    expect(message).toContain('"denied"');
    expect(message).toContain("projet");
    expect(message).toContain("copilot, opencode");
  });

  it("liste vide : le dit explicitement plutôt que de rendre une parenthèse vide", () => {
    const message = materializationNotice("allowed", "local", []);
    expect(message).toContain("vide");
  });
});
