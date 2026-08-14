import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs.js";
import { renderSectionRule, renderWordmark, WORDMARK_LINES, WORDMARK_WIDTH } from "./wordmark.js";

/** Displayed length: ANSI sequences occupy no columns. */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

describe("wordmark", () => {
  it("every line is exactly the announced width", () => {
    // This is the assertion that protects the drawing: a line one character
    // too long or too short misaligns a letter, and nothing else would say so.
    for (const line of WORDMARK_LINES) expect([...line].length).toBe(WORDMARK_WIDTH);
  });

  it("uses only full blocks, double strokes and spaces", () => {
    expect(WORDMARK_LINES.join("")).toMatch(/^[█╔╗╚╝═║ ]+$/);
  });

  it("carries one color per line, from lightest to darkest", () => {
    const lines = renderWordmark(UNICODE_GLYPHS, "truecolor");
    expect(lines).toHaveLength(6);
    const codes = lines.map((line) => /38;2;(\d+);(\d+);(\d+)/.exec(line)?.[0]);
    expect(new Set(codes).size).toBe(6);
    for (const line of lines) expect(visibleLength(line)).toBe(WORDMARK_WIDTH);
  });

  it("without Unicode, renders the name on one line rather than a coarse drawing", () => {
    expect(renderWordmark(ASCII_GLYPHS, "truecolor")).toHaveLength(1);
    expect(renderWordmark(ASCII_GLYPHS, "none")).toEqual(["CAESAR"]);
  });

  it("the tagline is added as the last line", () => {
    const lines = renderWordmark(UNICODE_GLYPHS, "none", "sub-agent orchestrator · v0.1.0");
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe("  sub-agent orchestrator · v0.1.0");
  });

  it("without color, leaves no ANSI sequence behind", () => {
    expect(renderWordmark(UNICODE_GLYPHS, "none").join("\n")).not.toMatch(/\x1b\[/);
  });
});

describe("command banner", () => {
  it("occupies exactly the requested width", () => {
    for (const width of [40, 60, 80, 120]) {
      expect(visibleLength(renderSectionRule("doctor", width, UNICODE_GLYPHS, "truecolor"))).toBe(width);
    }
  });

  it("never overflows, even when the label does not fit", () => {
    // The rule disappears rather than pushing the banner onto two lines.
    const rule = renderSectionRule("a-command-with-an-endless-name", 20, UNICODE_GLYPHS, "none");
    expect(rule).not.toMatch(/─/);
  });

  it("keeps the same width with the ASCII set", () => {
    expect(visibleLength(renderSectionRule("ps", 80, ASCII_GLYPHS, "none"))).toBe(80);
    expect(renderSectionRule("ps", 80, ASCII_GLYPHS, "none")).toMatch(/^:: caesar - ps -+$/);
  });

  it("names the command", () => {
    expect(renderSectionRule("doctor", 80, UNICODE_GLYPHS, "none")).toMatch(/caesar · doctor/);
  });
});
