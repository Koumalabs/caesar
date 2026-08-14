/**
 * The defect this table exists to fix is checked by eye on the rendered
 * grid: two neighboring cells must never touch, and no line must exceed
 * the terminal width (beyond it, the terminal wraps, and the overview
 * becomes unreadable exactly where it was supposed to inform).
 */
import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { useTerminalDimensions } from "@opentui/react";
import { Table } from "./Table";

interface Row {
  id: string;
  path: string;
  version: string;
}

const ROWS: Row[] = [
  { id: "codex", path: "/Users/someone/.local/share/mise/installs/node/22.11.0/bin/codex", version: "0.1.7" },
  { id: "antigravity", path: "/Users/someone/.local/bin/antigravity", version: "1.1.11" },
];

const COLUMNS = [
  { header: "agent", min: 12, cell: (row: Row) => row.id },
  { header: "binary", flex: 1, cell: (row: Row) => row.path },
  { header: "version", min: 10, cell: (row: Row) => row.version },
];

/** The component under test reads the terminal's real width, like the screens do. */
function Harness() {
  const { width } = useTerminalDimensions();
  return <Table columns={COLUMNS} rows={ROWS} keyOf={(row) => row.id} selectedIndex={0} width={width} />;
}

async function frameAt(width: number): Promise<{ frame: string; destroy: () => void }> {
  const setup = await act(async () => testRender(<Harness />, { width, height: 12 }));
  await act(async () => setup.renderOnce());
  return { frame: setup.captureCharFrame(), destroy: () => setup.renderer.destroy() };
}

describe("Table", () => {
  it("always separates two columns, even when the left value is truncated", async () => {
    const { frame, destroy } = await frameAt(60);
    const line = frame.split("\n").find((candidate) => candidate.includes("codex"))!;

    // The path does not fit: it is cut. The elision must be followed by a
    // space, never directly by the version — exactly the observed defect
    // ("…codex-cli 0.1…7 notable(s)").
    expect(line).toContain("…");
    expect(line).not.toMatch(/…\S/);
    expect(line).toContain("0.1.7");
    destroy();
  });

  it("occupies the available width rather than a hard-coded one", async () => {
    const narrow = await frameAt(60);
    const wide = await frameAt(160);

    // On a wide terminal, the flexible column expands: the path that was
    // truncated at 60 columns fits in full at 160.
    expect(narrow.frame).not.toContain("/Users/someone/.local/bin/antigravity");
    expect(wide.frame).toContain("/Users/someone/.local/bin/antigravity");
    narrow.destroy();
    wide.destroy();
  });

  it("no line exceeds the terminal width", async () => {
    for (const width of [40, 80, 200]) {
      const { frame, destroy } = await frameAt(width);
      for (const line of frame.split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(width);
      destroy();
    }
  });
});
