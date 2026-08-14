import { describe, expect, it } from "vitest";
import { makeIo, type CapturedIo } from "../../test/support.js";
import { runProtocolSchema } from "./protocol.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

describe("caesar protocol schema", () => {
  it("without an argument: lists the three available documents", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema(undefined, { json: true }, io);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(io.stdoutText())).toEqual({ documents: ["task", "report", "event"] });
  });

  it.each(["task", "report"] as const)("publishes a valid JSON Schema for \"%s\"", async (name) => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema(name, {}, io);
    expect(code).toBe(EXIT_OK);
    const schema = JSON.parse(io.stdoutText());
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("publishes a valid JSON Schema for \"event\" (discriminated union: oneOf)", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("event", {}, io);
    expect(code).toBe(EXIT_OK);
    const schema = JSON.parse(io.stdoutText());
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.oneOf.length).toBeGreaterThan(0);
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("--strict: \"report\" variant with additionalProperties: false and everything required, the optional being made nullable", async () => {
    // What the command publishes must be exactly what the provider accepts:
    // `required` covers the entirety of `properties`, failing which the API
    // refuses the whole request (observed on a real delegation to Codex, on
    // `commands_run.items.exit_code`). The intent of I2 — not making it
    // fabricate a measured `usage.cost_usd` nor an invented
    // `findings[].line` — holds through the nullability of those fields.
    // The rule itself is checked at every depth on the `@caesar/protocol`
    // side; here we check that the command publishes it undistorted.
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("report", { strict: true }, io);
    expect(code).toBe(EXIT_OK);
    const schema = JSON.parse(io.stdoutText());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(schema.required).toContain("usage");
    expect(schema.properties.usage.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "null" })]),
    );
  });

  it("--strict on anything but \"report\": usage error", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("task", { strict: true }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/--strict/);
  });

  it("unknown document: usage error", async () => {
    const io: CapturedIo = makeIo();
    const code = await runProtocolSchema("bogus", {}, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/bogus/);
  });
});
