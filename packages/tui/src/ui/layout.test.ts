import { describe, expect, it } from "bun:test";
import { cell, layoutColumns, wrap } from "./layout";

const GUTTER = 2;

/** What the terminal really sees: the widths, plus the gutters between them. */
function occupied(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * GUTTER;
}

describe("layoutColumns", () => {
  it("a column is never narrower than its header", () => {
    const widths = layoutColumns([{ header: "authorization" }, { header: "id" }], 200);
    expect(widths[0]).toBeGreaterThanOrEqual("authorization".length);
  });

  it("distributes the surplus according to flex, and does not lose a column on the way", () => {
    const widths = layoutColumns([{ header: "a", flex: 1 }, { header: "b", flex: 3 }], 42);
    expect(occupied(widths)).toBe(42);
    // `flex` shares the *surplus*, not the width: both columns start from
    // the same floor (4 characters, below which a cell is nothing but an
    // elision), and the second receives three times more of what remains.
    expect(widths[1]! - 4).toBe(3 * (widths[0]! - 4));
  });

  it("a capped column stops growing, and lets the others continue", () => {
    // Without a cap, the "status" column stretched to forty characters on a
    // wide terminal to display "0.1.7" there, pushing its neighbors apart.
    const widths = layoutColumns([{ header: "status", flex: 1, max: 12 }, { header: "capabilities", flex: 1, max: 40 }], 200);
    expect(widths[0]).toBe(12);
    expect(widths[1]).toBe(40);
  });

  it("without flex, leaves the room unused rather than stretching arbitrarily", () => {
    const widths = layoutColumns([{ header: "agent", min: 10 }, { header: "version", min: 10 }], 200);
    expect(widths).toEqual([10, 10]);
  });

  it("when room runs out, shaves all the columns rather than sacrificing one", () => {
    const widths = layoutColumns([{ header: "agent", min: 20 }, { header: "binary", min: 20 }, { header: "status", min: 20 }], 40);
    expect(occupied(widths)).toBeLessThanOrEqual(40);
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(4);
  });

  it("never exceeds the available room, whatever it is", () => {
    const specs = [{ header: "agent", min: 12, flex: 1 }, { header: "binary", flex: 3 }, { header: "policy", min: 12 }];
    for (let available = 20; available <= 220; available += 7) {
      expect(occupied(layoutColumns(specs, available))).toBeLessThanOrEqual(Math.max(available, 3 * 4 + 2 * GUTTER));
    }
  });
});

describe("cell", () => {
  it("pads to the exact width", () => {
    expect(cell("ok", 5)).toBe("ok   ");
  });

  it("truncates with an elision, without ever exceeding", () => {
    expect(cell("interminable", 5)).toBe("inte…");
    expect(cell("interminable", 5).length).toBe(5);
  });
});

describe("wrap", () => {
  it("wraps on spaces, without exceeding the width", () => {
    const lines = wrap("a denial reason long enough not to fit here", 20);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toBe("a denial reason long enough not to fit here");
  });

  it("cuts a word longer than the line — a path has no space to wrap on", () => {
    const lines = wrap("/usr/local/share/something/rather/very/long", 12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
    expect(lines.join("")).toBe("/usr/local/share/something/rather/very/long");
  });

  it("preserves explicit line breaks", () => {
    expect(wrap("one\ntwo", 20)).toEqual(["one", "two"]);
  });
});
