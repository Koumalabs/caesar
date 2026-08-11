import { describe, expect, it } from "vitest";
import {
  createGenericAgent,
  formatArgTemplate,
  splitArgTemplate,
  validateGenericAgentSpec,
} from "./generic.js";
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
      // « inconnu », et non « fermé » : sans `networkArgs`, l'orchestrateur
      // n'a aucune idée de ce que ce CLI fait du réseau.
      network: "unknown",
    });
  });

  it("des arguments réseau déclarés font passer la capacité à « pilotable »", () => {
    const agent = createGenericAgent({
      id: "mon-cli",
      bin: "mon-cli",
      args: ["{{prompt}}"],
      networkArgs: ["--online"],
    });
    expect(agent.capabilities.network).toBe("toggle");
  });

  it("n'ajoute les arguments réseau que lorsque la tâche a droit au réseau", () => {
    const agent = createGenericAgent({
      id: "mon-cli",
      bin: "mon-cli",
      args: ["{{prompt}}"],
      networkArgs: ["--online"],
    });
    expect(agent.build(sampleContext({ task: sampleTask({ network: true }) })).args).toContain("--online");
    expect(agent.build(sampleContext({ task: sampleTask({ network: false }) })).args).not.toContain("--online");
  });

  it("refuse un jeton inconnu jusque dans les arguments réseau", () => {
    // Sans ce contrôle, la coquille ferait disparaître l'argument entier
    // (voir `substitute`) : l'agent partirait sans réseau tout en annonçant
    // « réseau pilotable ».
    const error = validateGenericAgentSpec({
      id: "mon-cli",
      bin: "mon-cli",
      args: ["{{prompt}}"],
      networkArgs: ["--proxy={{prxy}}"],
    });
    expect(error).toContain("{{prxy}}");
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

  it("déduit la capacité \"modèle\" de la présence de {{model}} dans les arguments", () => {
    // Rien d'autre ne porte le choix du modèle pour un agent générique : la
    // capacité annoncée par `orch agents list` doit suivre les arguments, pas
    // une case cochée à côté d'eux.
    expect(createGenericAgent({ id: "a", bin: "a", args: ["{{prompt}}"] }).capabilities.model).toBe(false);
    expect(createGenericAgent({ id: "a", bin: "a", args: ["--model", "{{model}}", "{{prompt}}"] }).capabilities.model).toBe(true);
  });

  it("une capacité explicitement fournie l'emporte sur la déduction", () => {
    const agent = createGenericAgent({ id: "a", bin: "a", args: ["--model={{model}}"], capabilities: { model: false } });
    expect(agent.capabilities.model).toBe(false);
  });

  it("un jeton inconnu fait disparaître son argument, comme un jeton connu sans valeur", () => {
    // Le comportement que `validateGenericAgentSpec` existe pour prévenir :
    // sans elle, une faute de frappe retire silencieusement l'argument.
    const agent = createGenericAgent({ id: "a", bin: "a", args: ["--message", "{{promt}}"] });
    expect(agent.build(sampleContext()).args).toEqual(["--message"]);
  });
});

describe("splitArgTemplate", () => {
  it("découpe sur les espaces", () => {
    expect(splitArgTemplate("exec --json {{prompt}}")).toEqual(["exec", "--json", "{{prompt}}"]);
  });

  it("respecte les guillemets doubles et simples", () => {
    expect(splitArgTemplate('--system "tu es {{prompt}}"')).toEqual(["--system", "tu es {{prompt}}"]);
    expect(splitArgTemplate("--system 'deux mots'")).toEqual(["--system", "deux mots"]);
  });

  it("garde un argument vide explicitement écrit", () => {
    expect(splitArgTemplate('--flag "" {{prompt}}')).toEqual(["--flag", "", "{{prompt}}"]);
  });

  it("ignore les espaces multiples et les bords", () => {
    expect(splitArgTemplate("   exec    {{prompt}}  ")).toEqual(["exec", "{{prompt}}"]);
    expect(splitArgTemplate("")).toEqual([]);
    expect(splitArgTemplate("   ")).toEqual([]);
  });

  it("colle les segments accolés à un groupe entre guillemets", () => {
    expect(splitArgTemplate('--msg="{{prompt}} !"')).toEqual(["--msg={{prompt}} !"]);
  });

  it("lève sur guillemet non refermé plutôt que de rendre un argument amputé", () => {
    expect(() => splitArgTemplate('--system "tu es')).toThrow(/non refermé/);
  });
});

describe("formatArgTemplate", () => {
  it("ne met entre guillemets que ce qui en a besoin", () => {
    expect(formatArgTemplate(["exec", "--json", "{{prompt}}"])).toBe("exec --json {{prompt}}");
    expect(formatArgTemplate(["--system", "tu es {{prompt}}"])).toBe('--system "tu es {{prompt}}"');
    expect(formatArgTemplate([""])).toBe('""');
  });

  it("choisit le guillemet simple quand l'argument contient un guillemet double", () => {
    expect(formatArgTemplate(['dis "salut"'])).toBe(`'dis "salut"'`);
  });

  it("fait l'aller-retour avec splitArgTemplate", () => {
    for (const args of [["exec", "--json", "{{prompt}}"], ["--system", "tu es {{prompt}}"], ["--flag", "", "x"], ['dis "salut"']]) {
      expect(splitArgTemplate(formatArgTemplate(args))).toEqual(args);
    }
  });
});

describe("validateGenericAgentSpec", () => {
  const ok = { id: "aider", bin: "aider", args: ["--message", "{{prompt}}"] };

  it("accepte une déclaration utilisable", () => {
    expect(validateGenericAgentSpec(ok)).toBeNull();
  });

  it("refuse un identifiant vide ou exotique", () => {
    expect(validateGenericAgentSpec({ ...ok, id: "" })).toMatch(/ne peut pas être vide/);
    expect(validateGenericAgentSpec({ ...ok, id: "mon agent" })).toMatch(/invalide/);
    expect(validateGenericAgentSpec({ ...ok, id: "-agent" })).toMatch(/invalide/);
  });

  it("refuse un binaire vide", () => {
    expect(validateGenericAgentSpec({ ...ok, bin: "  " })).toMatch(/n'a pas de binaire/);
  });

  it("nomme le jeton inconnu et rappelle les jetons connus", () => {
    const error = validateGenericAgentSpec({ ...ok, args: ["--message", "{{promt}}"] });
    expect(error).toMatch(/\{\{promt\}\}/);
    expect(error).toMatch(/\{\{prompt\}\}/);
    expect(error).toMatch(/disparaît entièrement/);
  });

  it("refuse un gabarit qui ne transmet jamais l'objectif", () => {
    expect(validateGenericAgentSpec({ ...ok, args: ["exec", "--json"] })).toMatch(/objectif de la tâche/);
  });

  it("accepte {{prompt}} collé à d'autres jetons ou à du texte", () => {
    expect(validateGenericAgentSpec({ ...ok, args: ["--msg={{prompt}}"] })).toBeNull();
  });
});
