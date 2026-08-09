import { describe, expect, it } from "vitest";
import { colorize, printError, printJson, printWarning, renderTable, writeLine } from "./output.js";
import { makeIo, type CapturedIo } from "../test/support.js";

describe("output", () => {
  it("printJson n'écrit que le JSON, sans couleur, terminé par un saut de ligne", () => {
    const io: CapturedIo = makeIo();
    printJson(io, { a: 1, b: [1, 2] });
    expect(io.stdoutText()).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("printError écrit sur stderr, jamais sur stdout", () => {
    const io: CapturedIo = makeIo();
    printError(io, "quelque chose a mal tourné");
    expect(io.stderrText()).toBe("quelque chose a mal tourné\n");
    expect(io.stdoutText()).toBe("");
  });

  it("printWarning écrit sur stderr", () => {
    const io: CapturedIo = makeIo();
    printWarning(io, "attention");
    expect(io.stderrText()).toBe("attention\n");
  });

  it("colorize ne colore jamais un flux sans isTTY (cas des tests, et de tout pipe)", () => {
    const io: CapturedIo = makeIo();
    expect(colorize("texte", "red", io.stdout)).toBe("texte");
  });

  it("colorize respecte NO_COLOR même sur un flux isTTY", () => {
    const io: CapturedIo = makeIo();
    (io.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const previous = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      expect(colorize("texte", "red", io.stdout)).toBe("texte");
    } finally {
      if (previous === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = previous;
    }
  });

  it("colorize colore un flux isTTY sans NO_COLOR", () => {
    const io: CapturedIo = makeIo();
    (io.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const previous = process.env["NO_COLOR"];
    delete process.env["NO_COLOR"];
    try {
      expect(colorize("texte", "red", io.stdout)).toBe("\x1b[31mtexte\x1b[0m");
    } finally {
      if (previous !== undefined) process.env["NO_COLOR"] = previous;
    }
  });

  it("writeLine ajoute un saut de ligne", () => {
    const io: CapturedIo = makeIo();
    writeLine(io.stdout, "bonjour");
    expect(io.stdoutText()).toBe("bonjour\n");
  });

  it("renderTable aligne les colonnes, avec un séparateur sous les en-têtes", () => {
    const table = renderTable(["id", "nom"], [["1", "courte"], ["22", "plus longue"]]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("id  nom        ");
    expect(lines[1]).toBe("--  -----------");
  });
});
