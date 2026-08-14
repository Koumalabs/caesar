import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, glyphsFor, supportsUnicode, UNICODE_GLYPHS } from "./glyphs.js";

describe("supportsUnicode", () => {
  it("recognizes UTF-8 under both of its spellings", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(supportsUnicode({ LANG: "fr_FR.utf8" })).toBe(true);
  });

  it("refuses an explicit POSIX locale", () => {
    expect(supportsUnicode({ LC_ALL: "C" })).toBe(false);
    expect(supportsUnicode({ LANG: "C" })).toBe(false);
  });

  it("respects POSIX precedence: LC_ALL, then LC_CTYPE, then LANG", () => {
    expect(supportsUnicode({ LC_ALL: "C", LC_CTYPE: "en_US.UTF-8", LANG: "en_US.UTF-8" })).toBe(false);
    expect(supportsUnicode({ LC_CTYPE: "C", LANG: "en_US.UTF-8" })).toBe(false);
    expect(supportsUnicode({ LC_ALL: "en_US.UTF-8", LANG: "C" })).toBe(true);
  });

  it("answers yes when nothing is declared", () => {
    // The common case on macOS: UTF-8 terminal, no variable set. Answering
    // no would deprive the majority of the theme to protect a minority
    // that, for its part, always signals itself (LC_ALL=C).
    expect(supportsUnicode({})).toBe(true);
    expect(supportsUnicode({ LANG: "" })).toBe(true);
  });
});

describe("glyphsFor", () => {
  it("chooses the set according to the locale", () => {
    expect(glyphsFor({ LANG: "en_US.UTF-8" })).toBe(UNICODE_GLYPHS);
    expect(glyphsFor({ LC_ALL: "C" })).toBe(ASCII_GLYPHS);
  });

  it("both sets occupy the same width, character by character", () => {
    // All of `renderTable`'s width arithmetic depends on it: a wider ASCII
    // fallback would shift every right border.
    const box = Object.keys(UNICODE_GLYPHS.box) as (keyof typeof UNICODE_GLYPHS.box)[];
    for (const key of box) {
      expect([...UNICODE_GLYPHS.box[key]].length).toBe([...ASCII_GLYPHS.box[key]].length);
    }
    const status = Object.keys(UNICODE_GLYPHS.status) as (keyof typeof UNICODE_GLYPHS.status)[];
    for (const key of status) {
      expect([...UNICODE_GLYPHS.status[key]].length).toBe([...ASCII_GLYPHS.status[key]].length);
    }
    expect([...UNICODE_GLYPHS.ellipsis].length).toBe([...ASCII_GLYPHS.ellipsis].length);
  });

  it("the ASCII set uses nothing but ASCII", () => {
    const everything = [
      ...Object.values(ASCII_GLYPHS.box),
      ...Object.values(ASCII_GLYPHS.status),
      ASCII_GLYPHS.ellipsis,
    ].join("");
    // eslint-disable-next-line no-control-regex
    expect(everything).toMatch(/^[\x20-\x7e]+$/);
  });
});
