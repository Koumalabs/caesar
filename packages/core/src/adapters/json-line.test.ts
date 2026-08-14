import { describe, expect, it } from "vitest";
import { isRecord, parseJsonLine } from "./json-line.js";

describe("parseJsonLine", () => {
  it("returns undefined for an empty or whitespace-only line", () => {
    expect(parseJsonLine("")).toBeUndefined();
    expect(parseJsonLine("   \t  ")).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseJsonLine("{not json")).toBeUndefined();
    expect(parseJsonLine("hello")).toBeUndefined();
  });

  it("parses a valid JSON object, ignoring surrounding whitespace", () => {
    expect(parseJsonLine('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it("also parses non-object forms (array, primitive)", () => {
    expect(parseJsonLine("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseJsonLine("42")).toBe(42);
    expect(parseJsonLine("null")).toBeNull();
  });
});

describe("isRecord", () => {
  it("true for a plain object", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  it("false for an array, null, or a primitive value", () => {
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
