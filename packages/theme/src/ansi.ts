/**
 * Translation of a hexadecimal color into an ANSI sequence, with degradation.
 *
 * The palette is expressed in hexadecimal because it is the only way to
 * choose a shade: "cyan" describes nothing, and that is why the command
 * line had no theme but a series of local choices. Yet not every terminal
 * can render 16 million colors — this module bridges that gap, from the
 * richest to the poorest, without the caller ever having to care.
 *
 * Nothing here reads `process.env`: the environment is always passed as a
 * parameter. This package therefore depends on nothing, not even Node, and
 * each degradation tier is tested without touching the test process.
 */

/** The environment the terminal's capabilities are deduced from — `process.env`, or a test object. */
export type Environment = Readonly<Record<string, string | undefined>>;

export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "none";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";

/**
 * What the terminal can render.
 *
 * Deliberately **conservative** in the absence of `COLORTERM`: a terminal
 * that does not announce it gets the 16 base colors. Emitting 256-color
 * codes blindly at a terminal that ignores them does not display an
 * approximate color but the sequence itself, verbatim, in the middle of the
 * text. The price of caution is a coarser palette on an old ssh session;
 * the price of optimism would be broken output.
 *
 * `NO_COLOR` overrides everything (https://no-color.org), as does
 * `TERM=dumb`, which describes a terminal with no control sequences at all.
 */
export function detectColorDepth(env: Environment): ColorDepth {
  if (env["NO_COLOR"]) return "none";
  const term = (env["TERM"] ?? "").toLowerCase();
  if (term === "dumb") return "none";
  const colorterm = (env["COLORTERM"] ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  if (term.includes("256color")) return "ansi256";
  return "ansi16";
}

/** `#7AA2F7` → `[122, 162, 247]`. Tolerates a missing `#` and the short form `#abc`. */
export function parseHex(hex: string): readonly [number, number, number] {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  // Check the shape rather than trusting `Number.parseInt`, which stops at
  // the first invalid character without reporting it: it would silently turn
  // "12345g" into 0x12345 — a wrong color rather than an error.
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Invalid hexadecimal color: "${hex}".`);
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** The six tiers of each axis of the 6×6×6 cube of colors 16 through 231. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeIndex(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_LEVELS.length; i += 1) {
    if (Math.abs((CUBE_LEVELS[i] ?? 0) - value) < Math.abs((CUBE_LEVELS[best] ?? 0) - value)) best = i;
  }
  return best;
}

/**
 * Index into the 256-color palette.
 *
 * Two candidates compete, not one: the 6×6×6 cube (indices 16 through 231)
 * and the 24-step gray ramp (232 through 255). A half-tone like #8992A6
 * falls between two tiers of the cube; the nearest gray is often more
 * faithful to it. Considering only the cube would give secondary text a
 * slight tint — blue or violet, in that case.
 */
export function toAnsi256(rgb: readonly [number, number, number]): number {
  const cubeIndex = [rgb[0], rgb[1], rgb[2]].map(nearestCubeIndex);
  const cubeRgb: readonly [number, number, number] = [
    CUBE_LEVELS[cubeIndex[0] ?? 0] ?? 0,
    CUBE_LEVELS[cubeIndex[1] ?? 0] ?? 0,
    CUBE_LEVELS[cubeIndex[2] ?? 0] ?? 0,
  ];

  const average = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
  const grayStep = Math.min(23, Math.max(0, Math.round((average - 8) / 10)));
  const grayValue = 8 + grayStep * 10;
  const grayRgb: readonly [number, number, number] = [grayValue, grayValue, grayValue];

  if (distance(rgb, grayRgb) < distance(rgb, cubeRgb)) return 232 + grayStep;
  return 16 + 36 * (cubeIndex[0] ?? 0) + 6 * (cubeIndex[1] ?? 0) + (cubeIndex[2] ?? 0);
}

/** The six hue sectors of the base colors, and their dark SGR code. */
const HUE_SECTORS: ReadonlyArray<{ center: number; code: number }> = [
  { center: 0, code: 31 }, // red
  { center: 60, code: 33 }, // yellow
  { center: 120, code: 32 }, // green
  { center: 180, code: 36 }, // cyan
  { center: 240, code: 34 }, // blue
  { center: 300, code: 35 }, // magenta
];

/** The four available neutrals, identified by their lightness. */
const NEUTRALS: ReadonlyArray<{ lightness: number; code: number }> = [
  { lightness: 0.0, code: 30 }, // black
  { lightness: 0.5, code: 90 }, // gray (bright black)
  { lightness: 0.9, code: 37 }, // white
  { lightness: 1.0, code: 97 }, // bright white
];

/**
 * Below this, a color no longer carries an identifiable hue: it is a
 * neutral, and rendering it as "green" or "blue" would be wrong.
 */
const CHROMA_THRESHOLD = 0.2;

/**
 * SGR code of the nearest of the 16 base colors — **by hue, not by
 * distance**.
 *
 * Euclidean distance in RGB, the seemingly obvious choice, gives an absurd
 * result here: `OK` (#7DCE82, a pastel green) is numerically 6,254 away
 * from mid-gray and 32,526 away from pure green. The whole semantic
 * palette would thus collapse into gray, and the 16-color fallback would
 * lose exactly what it must preserve — the distinction between "allowed"
 * and "denied".
 *
 * So we reason like the eye: hue first, then lightness. A color too weakly
 * chromatic to have a hue is treated as a neutral, and chosen on its
 * lightness alone.
 *
 * At this tier, `DIM` and `FAINT` both fall back to gray: the theme's
 * three-level hierarchy flattens to two. That is the limit of sixteen
 * colors, not a flaw in the palette — structure (boxes, headers, indents)
 * keeps carrying the reading.
 */
export function toAnsi16(rgb: readonly [number, number, number]): number {
  const [r, g, b] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation = chroma === 0 || lightness === 0 || lightness === 1 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));

  if (saturation < CHROMA_THRESHOLD) {
    let best = NEUTRALS[0] ?? { lightness: 0, code: 30 };
    for (const candidate of NEUTRALS) {
      if (Math.abs(candidate.lightness - lightness) < Math.abs(best.lightness - lightness)) best = candidate;
    }
    return best.code;
  }

  let hue: number;
  if (max === r) hue = 60 * (((g - b) / chroma) % 6);
  else if (max === g) hue = 60 * ((b - r) / chroma + 2);
  else hue = 60 * ((r - g) / chroma + 4);
  if (hue < 0) hue += 360;

  let sector = HUE_SECTORS[0] ?? { center: 0, code: 31 };
  const gap = (a: number, c: number): number => {
    const raw = Math.abs(a - c);
    return Math.min(raw, 360 - raw);
  };
  for (const candidate of HUE_SECTORS) {
    if (gap(hue, candidate.center) < gap(hue, sector.center)) sector = candidate;
  }
  // The bright variants are the only ones readable on a dark background;
  // above mid-lightness, that is the one we want.
  return lightness >= 0.5 ? sector.code + 60 : sector.code;
}

/** Opening sequence for a foreground color. Empty string if the terminal does not color. */
export function foreground(hex: string, depth: ColorDepth): string {
  if (depth === "none") return "";
  const rgb = parseHex(hex);
  if (depth === "truecolor") return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (depth === "ansi256") return `\x1b[38;5;${toAnsi256(rgb)}m`;
  return `\x1b[${toAnsi16(rgb)}m`;
}

/**
 * Dresses `text`. Returns the text **unchanged** when nothing applies: no
 * empty sequence, no orphan `RESET` — that is what lets `--json` and the
 * tests compare bare strings.
 */
export function paint(text: string, style: { hex?: string; bold?: boolean }, depth: ColorDepth): string {
  if (depth === "none") return text;
  const prefix = (style.bold ? BOLD : "") + (style.hex ? foreground(style.hex, depth) : "");
  return prefix === "" ? text : prefix + text + RESET;
}
