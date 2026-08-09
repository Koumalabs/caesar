import { describe, expect, it } from "vitest";
import { createGenericAgent } from "./generic.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const { sampleTask, sampleContext } = makeSampleFactory("mon-cli");

describe("createGenericAgent", () => {
  it("utilise l'identifiant comme nom d'affichage par défaut", () => {
    const agent = createGenericAgent({ id: "mon-cli", bin: "mon-cli", args: [] });
    expect(agent.displayName).toBe("mon-cli");
  });

  it("substitue les jetons connus", () => {
    const agent = createGenericAgent({
      id: "mon-cli",
      bin: "mon-cli",
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

  it("fait disparaître l'argument entier dont le jeton n'a pas de valeur", () => {
    const agent = createGenericAgent({
      id: "mon-cli",
      bin: "mon-cli",
      args: ["run", "--model={{model}}", "{{prompt}}"],
    });
    const sansModele = agent.build(sampleContext());
    expect(sansModele.args).toEqual(["run", "PROMPT"]);

    const avecModele = agent.build(sampleContext({ model: "gpt-5" }));
    expect(avecModele.args).toEqual(["run", "--model=gpt-5", "PROMPT"]);
  });

  it("ajoute les arguments bruts après les arguments du gabarit", () => {
    const agent = createGenericAgent({ id: "mon-cli", bin: "mon-cli", args: ["{{prompt}}"] });
    const plan = agent.build(sampleContext({ extraArgs: ["--verbose"] }));
    expect(plan.args).toEqual(["PROMPT", "--verbose"]);
  });

  it("porte le workspace par le cwd en mode process (par défaut)", () => {
    const agent = createGenericAgent({ id: "mon-cli", bin: "mon-cli", args: [] });
    const plan = agent.build(sampleContext());
    expect(plan.cwd).toBe("/tmp/wt");
  });

  it("ne duplique pas le workspace sur le cwd en mode flag", () => {
    const agent = createGenericAgent({
      id: "mon-cli",
      bin: "mon-cli",
      args: ["--dir={{workspace}}"],
      cwdMode: "flag",
    });
    const plan = agent.build(sampleContext());
    expect(plan.cwd).toBe(paths.dir);
  });

  it("valeurs neutres pour les capacités non précisées, mcpInjection à none", () => {
    const agent = createGenericAgent({ id: "mon-cli", bin: "mon-cli", args: [] });
    expect(agent.capabilities).toEqual({
      jsonEvents: false,
      outputSchema: false,
      finalMessageFile: false,
      nativeReadOnly: false,
      resume: false,
      addDir: false,
      mcpInjection: "none",
      model: false,
    });
  });

  it("se contente du palier fichier même si un canal est disponible (mcpInjection none)", () => {
    const agent = createGenericAgent({ id: "mon-cli", bin: "mon-cli", args: [] });
    expect(agent.preferredReportChannel(sampleTask(), true)).toBe("file");
  });

  it("respecte les capacités explicitement fournies", () => {
    const agent = createGenericAgent({
      id: "mon-cli",
      bin: "mon-cli",
      args: [],
      capabilities: { outputSchema: true },
    });
    expect(agent.preferredReportChannel(sampleTask(), false)).toBe("schema");
  });

  it("ne traduit jamais rien : le format de sortie d'un CLI générique est inconnu", () => {
    const agent = createGenericAgent({ id: "mon-cli", bin: "mon-cli", args: [] });
    expect(agent.translate('{"type":"message","text":"salut"}')).toEqual({ events: [] });
    expect(agent.translate("")).toEqual({ events: [] });
  });

  it("place le bin fourni comme command du plan", () => {
    const agent = createGenericAgent({ id: "mon-cli", bin: "/usr/local/bin/mon-cli", args: [] });
    const plan = agent.build(sampleContext());
    expect(plan.command).toBe("/usr/local/bin/mon-cli");
  });
});
