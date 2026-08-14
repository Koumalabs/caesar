import { describe, expect, it } from "vitest";
import {
  detectColorDepth,
  foreground,
  paint,
  parseHex,
  RESET,
  toAnsi16,
  toAnsi256,
} from "./ansi.js";
import { ACCENT, BAD, DIM, FAINT, OK, WARN } from "./palette.js";

describe("detectColorDepth", () => {
  it("NO_COLOR overrides everything, including COLORTERM", () => {
    expect(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-256color" })).toBe("none");
  });

  it('TERM=dumb describes a terminal with no control sequences', () => {
    expect(detectColorDepth({ TERM: "dumb" })).toBe("none");
  });

  it("COLORTERM announces truecolor, under both of its spellings", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor", TERM: "xterm-ghostty" })).toBe("truecolor");
    expect(detectColorDepth({ COLORTERM: "24bit" })).toBe("truecolor");
  });

  it("a 256color TERM without COLORTERM yields 256 colors", () => {
    expect(detectColorDepth({ TERM: "screen-256color" })).toBe("ansi256");
  });

  it("with nothing announced, we stay on the 16 base colors", () => {
    // Deliberate caution: a 256-color sequence emitted at a terminal that
    // ignores it displays verbatim in the middle of the text.
    expect(detectColorDepth({ TERM: "xterm" })).toBe("ansi16");
    expect(detectColorDepth({})).toBe("ansi16");
  });
});

describe("parseHex", () => {
  it("reads the long form, with or without a hash", () => {
    expect(parseHex("#7AA2F7")).toEqual([0x7a, 0xa2, 0xf7]);
    expect(parseHex("7aa2f7")).toEqual([0x7a, 0xa2, 0xf7]);
  });

  it("expands the short form", () => {
    expect(parseHex("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("refuses what Number.parseInt would silently accept", () => {
    // "12345g" would be 0x12345 to parseInt: a wrong color, without a sound.
    expect(() => parseHex("#12345g")).toThrow(/Invalid/);
    expect(() => parseHex("#12345")).toThrow(/Invalid/);
  });
});

describe("color degradation", () => {
  it("truecolor renders the exact shade", () => {
    expect(foreground(ACCENT, "truecolor")).toBe("\x1b[38;2;234;165;46m");
  });

  it("256 colors renders an index into the cube or the gray ramp", () => {
    const escape = foreground(ACCENT, "ansi256");
    expect(escape).toMatch(/^\x1b\[38;5;\d{1,3}m$/);
  });

  it("a true gray goes through the gray ramp, which the cube cannot render", () => {
    // The 6×6×6 cube has only six tiers per axis: #808080 would become
    // #878787 there. The 24-step gray ramp renders it exactly.
    expect(toAnsi256([0x80, 0x80, 0x80])).toBe(244);
  });

  it("a half-tone that leans keeps its lean rather than turning gray", () => {
    // #8992A6 has 29 more points of blue than of red: the cube is more
    // faithful to it than the nearest gray, and the cube must win.
    const index = toAnsi256([0x89, 0x92, 0xa6]);
    expect(index).toBeLessThan(232);
    expect(index).toBe(103);
  });

  it("pure black and white stay in the cube", () => {
    expect(toAnsi256([0, 0, 0])).toBe(16);
    expect(toAnsi256([255, 255, 255])).toBe(231);
  });

  it("the semantic colors keep their hue at 16 colors", () => {
    // This is what Euclidean distance in RGB lost: these four shades are
    // half-tones, thus all closer to mid-gray than to their primary.
    // "Allowed" and "denied" would have become gray.
    expect(toAnsi16(parseHex(OK))).toBe(92); // bright green
    expect(toAnsi16(parseHex(WARN))).toBe(93); // bright yellow
    expect(toAnsi16(parseHex(BAD))).toBe(91); // bright red
    // The accent gold joins WARN on bright yellow: at 16 colors, the brand
    // and the warning share the same hue — the accepted price of a golden
    // accent; weight and context still tell them apart.
    expect(toAnsi16(parseHex(ACCENT))).toBe(93); // bright yellow
  });

  it("neutrals are chosen on their lightness, not on an invented hue", () => {
    expect(toAnsi16(parseHex(DIM))).toBe(90);
    expect(toAnsi16(parseHex(FAINT))).toBe(90);
    expect(toAnsi16([0, 0, 0])).toBe(30);
    expect(toAnsi16([255, 255, 255])).toBe(97);
  });

  it("dark primaries stay dark, bright ones stay bright", () => {
    expect(toAnsi16([0xcd, 0x00, 0x00])).toBe(31);
    expect(toAnsi16([0xff, 0x00, 0x00])).toBe(91);
    expect(toAnsi16([0x00, 0xcd, 0x00])).toBe(32);
  });

  it("no depth emits a sequence when color is off", () => {
    expect(foreground(ACCENT, "none")).toBe("");
  });
});

describe("paint", () => {
  it("returns the text strictly unchanged when color is off", () => {
    expect(paint("text", { hex: ACCENT, bold: true }, "none")).toBe("text");
  });

  it("emits neither an empty sequence nor an orphan RESET when no style applies", () => {
    expect(paint("text", {}, "truecolor")).toBe("text");
  });

  it("always closes what it opens", () => {
    expect(paint("text", { hex: ACCENT }, "truecolor")).toBe(`\x1b[38;2;234;165;46mtext${RESET}`);
    expect(paint("text", { bold: true }, "truecolor")).toBe(`\x1b[1mtext${RESET}`);
  });
});
