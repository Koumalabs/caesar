import { describe, expect, it } from "vitest";
import { isRecord, parseJsonLine } from "./json-line.js";

describe("parseJsonLine", () => {
  it("renvoie undefined pour une ligne vide ou faite d'espaces", () => {
    expect(parseJsonLine("")).toBeUndefined();
    expect(parseJsonLine("   \t  ")).toBeUndefined();
  });

  it("renvoie undefined pour du JSON invalide", () => {
    expect(parseJsonLine("{not json")).toBeUndefined();
    expect(parseJsonLine("bonjour")).toBeUndefined();
  });

  it("parse un objet JSON valide, en ignorant les espaces qui l'entourent", () => {
    expect(parseJsonLine('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it("parse aussi les formes non-objet (tableau, primitive)", () => {
    expect(parseJsonLine("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseJsonLine("42")).toBe(42);
    expect(parseJsonLine("null")).toBeNull();
  });
});

describe("isRecord", () => {
  it("vrai pour un objet simple", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  it("faux pour un tableau, null, ou une valeur primitive", () => {
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("texte")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
