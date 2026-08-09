import { describe, expect, it } from "vitest";
import { makeIo, type CapturedIo } from "../../test/support.js";
import { runProtocolSchema } from "./protocol.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

describe("orch protocol schema", () => {
  it("sans argument : liste les trois documents disponibles", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema(undefined, { json: true }, io);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(io.stdoutText())).toEqual({ documents: ["task", "report", "event"] });
  });

  it.each(["task", "report"] as const)("publie un JSON Schema valide pour \"%s\"", async (name) => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema(name, {}, io);
    expect(code).toBe(EXIT_OK);
    const schema = JSON.parse(io.stdoutText());
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("publie un JSON Schema valide pour \"event\" (union discriminée : oneOf)", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("event", {}, io);
    expect(code).toBe(EXIT_OK);
    const schema = JSON.parse(io.stdoutText());
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.oneOf.length).toBeGreaterThan(0);
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("--strict : variante \"report\" avec additionalProperties: false et tout requis", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("report", { strict: true }, io);
    expect(code).toBe(EXIT_OK);
    const schema = JSON.parse(io.stdoutText());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
  });

  it("--strict sur autre chose que \"report\" : erreur d'usage", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("task", { strict: true }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/--strict/);
  });

  it("document inconnu : erreur d'usage", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("bogus", {}, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/bogus/);
  });
});
