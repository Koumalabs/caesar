// Generates the site's raster brand assets from the wordmark's own geometry:
// the two Open Graph cards (one per locale), the Apple touch icon and the
// multi-resolution `favicon.ico`.
//
// Pure JavaScript with no monorepo import (only node:fs/node:path/node:url
// plus the three rendering dependencies), like `generate-agent-assets.mjs`
// next to it: this script is a build-time tool, not a package, and nothing in
// `tsc -b` depends on it.
//
// Invocation: `node scripts/generate-og.mjs` (also exposed via
// `pnpm run og:build`), from any directory — the repository root is resolved
// from this script's own location (`import.meta.url`), never from the cwd.
//
// The produced files are COMMITTED. Vercel never runs this script: a social
// card that only exists if a native binary installs cleanly on the build
// machine is a card that will one day be missing from a shared link.
//
// --- Why the text is traced into <path> rather than left as <text> ----------
//
// Three facts, each verified on this machine rather than taken from a README:
//
//  1. resvg's Node binding cannot read woff2 — the decoder is compiled for
//     wasm32 only. Worse, it fails SILENTLY: fontdb opens the file, finds no
//     face, and returns Ok, so the text renders in a fallback sans with no
//     warning at all.
//  2. Passing a font as `fontBuffers` also fails silently with 2.6.2: the
//     buffer loads but its family never matches. Only `fontFiles` binds.
//  3. resvg-js 2.6.2 pins resvg 0.34, and variable-font axes only landed in
//     resvg 0.47. Fraunces' shipped default instance is `wght 900` — the
//     landing's headings are 550. Left to resvg, every card would be set in
//     Fraunces Black and nothing would say so.
//
// Tracing the glyphs with fontkit answers all three at once, and buys the
// property that matters most here: the rendered SVG contains no <text> at
// all, so no font installed on the operator's machine can change the output.
// "Same sources, same bytes" holds by construction rather than by luck.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import * as fontkit from "fontkit";
import { decompress } from "wawoff2";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATIC_DIR = join(ROOT, "website", "static");
const IMG_DIR = join(STATIC_DIR, "img");
const WORDMARK_TS = join(ROOT, "packages", "theme", "src", "wordmark.ts");
const LOGO_SVG = join(ROOT, "assets", "logo.svg");
const FRAUNCES_DIR = join(ROOT, "website", "node_modules", "@fontsource-variable", "fraunces", "files");

// ---------------------------------------------------------------------------
// The palette — ported from packages/theme/src/palette.ts, same values as
// website/src/css/custom.css. The card is dark-first, like the landing: the
// dark ground IS the design, not a variant of it.
// ---------------------------------------------------------------------------

/** The wordmark's six stops, one per line: the light comes from above. */
const RAMP = ["#eaa52e", "#db9a2b", "#cc8f28", "#bd8425", "#ae7922", "#9f6e1f"];

const INK_GROUND = "#0c0904";
const INK = "#f0e9dc";
const INK_SECONDARY = "#9e9284";
const INK_FAINT = "#6b6252";
const ACCENT = "#eaa52e";
const HAIRLINE = "#9e9284";
const HAIRLINE_OPACITY = 0.18;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const LAYOUT = Object.freeze({
  W: 1200,
  H: 630,
  MARGIN: 72,

  /**
   * Geist Pixel's internal grid is 38 units on a 1000 em — every advance in
   * the font is a multiple of 38, and its cap height is 722 = 19 × 38. Only a
   * size of `1000 / 38` (or a multiple) puts one module on exactly one pixel;
   * at any other size a pixel typeface renders blurred, which rather defeats
   * the point. Cap height then falls on 19 px exactly.
   */
  ANNOT_SIZE: 1000 / 38,
  ANNOT_TRACK: 4,
  EYEBROW_BASELINE: 78,
  RULE_TOP: 106,

  /**
   * The wordmark at ×2. Every coordinate in the drawing grid is a multiple of
   * 0.5, so an even scale lands all of them on whole pixels — which matters
   * more than it sounds: at a fractional scale each shared edge gets a
   * half-covered pixel, and the wordmark comes out veined with a pale grid
   * along its cell joins. 957 × 205 at ×2.
   */
  MARK_SCALE: 2,
  MARK_X: 72,
  MARK_Y: 158,

  /** Fraunces at the landing's own heading setting: weight 550, −0.02 em. */
  TAG_SIZE: 46,
  TAG_TRACK_EM: -0.02,
  TAG_LEADING: 60,
  TAG_FIRST_BASELINE: 448,

  RULE_BOT: 528,
  FOOTER_BASELINE: 572,
});

const CONTENT_W = LAYOUT.W - 2 * LAYOUT.MARGIN;

// ---------------------------------------------------------------------------
// The wordmark, drawn as rectangles — no font involved
// ---------------------------------------------------------------------------

/**
 * The cell of the drawing grid, reverse-engineered from `assets/logo.svg` —
 * which is exactly this wordmark's "C" rendered as rectangles. Every constant
 * below was measured on that file's 55 rects, not invented, and `selfCheck()`
 * re-proves it on every run.
 *
 * A cell is 10 × 18 and holds one character. A double stroke is 2 units thick
 * and sits at a fixed offset: the two verticals at +1.5 and +6.5, the two
 * horizontals at +5.5 and +10.5 — both pairs symmetric about the cell's
 * center. Every stroke overruns its cell by one unit on the side it continues
 * towards, and that overrun is what welds adjacent glyphs into one silhouette
 * instead of a dotted line. It also makes the table purely local: no
 * lookahead, no context, no special case.
 */
const CELL_W = 10;
const CELL_H = 18;

/** Local `[x, y, w, h]` rects per character, in cell coordinates. */
const BOX_RECTS = Object.freeze({
  " ": [],
  "█": [[0, 0, 10, 18]],
  "═": [[-1, 5.5, 12, 2], [-1, 10.5, 12, 2]],
  "║": [[1.5, -1, 2, 20], [6.5, -1, 2, 20]],
  "╔": [[1.5, 5.5, 9.5, 2], [1.5, 5.5, 2, 13.5], [6.5, 10.5, 4.5, 2], [6.5, 10.5, 2, 8.5]],
  "╗": [[-1, 5.5, 9.5, 2], [6.5, 5.5, 2, 13.5], [-1, 10.5, 4.5, 2], [1.5, 10.5, 2, 8.5]],
  "╚": [[1.5, -1, 2, 13.5], [1.5, 10.5, 9.5, 2], [6.5, -1, 2, 8.5], [6.5, 5.5, 4.5, 2]],
  "╝": [[6.5, -1, 2, 13.5], [-1, 10.5, 9.5, 2], [1.5, -1, 2, 8.5], [-1, 5.5, 4.5, 2]],
});

/**
 * The six lines, read out of `packages/theme/src/wordmark.ts` as text rather
 * than imported: `packages/theme/dist/` is gitignored, so an import would
 * make this script depend on a prior `tsc -b` and break on a fresh checkout.
 * Every assumption is asserted, so a drift in the source fails loudly here
 * instead of quietly producing a wrong card.
 */
function readWordmarkLines() {
  const src = readFileSync(WORDMARK_TS, "utf8").replace(/\r\n/g, "\n");
  const block = /export const WORDMARK_LINES: readonly string\[\] = \[([\s\S]*?)\n\];/.exec(src);
  if (!block) throw new Error(`WORDMARK_LINES introuvable dans ${WORDMARK_TS}`);
  const lines = [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (lines.length !== 6) throw new Error(`wordmark : ${lines.length} lignes au lieu de 6`);
  for (const line of lines) {
    if ([...line].length !== 48) throw new Error(`wordmark : ligne de ${[...line].length} colonnes au lieu de 48`);
    for (const char of line) {
      if (!(char in BOX_RECTS)) throw new Error(`glyphe hors table : ${JSON.stringify(char)} (U+${char.codePointAt(0).toString(16).toUpperCase()})`);
    }
  }
  return lines;
}

/**
 * The rects of a column range, scaled and placed. `colEnd` is exclusive — the
 * logo's "C" is `[0, 8)`. `only` keeps a subset of characters, which is how
 * the smallest icon drops the relief (see `iconSvg`).
 */
function markRects(lines, { colStart = 0, colEnd = 48, scale = 1, x = 0, y = 0, only = null } = {}) {
  const out = [];
  lines.forEach((line, row) => {
    const chars = [...line];
    const fill = RAMP[row];
    const push = (rx, ry, rw, rh) =>
      out.push({ rect: [x + rx * scale, y + ry * scale, rw * scale, rh * scale], fill });

    // A run of solid blocks becomes one rect, the way `assets/logo.svg` writes
    // it. Not an optimisation — it is what makes `selfCheck` able to compare
    // this output to that file rect for rect.
    let runStart = -1;
    const flushRun = (col) => {
      if (runStart < 0) return;
      push((runStart - colStart) * CELL_W, row * CELL_H, (col - runStart) * CELL_W, CELL_H);
      runStart = -1;
    };

    for (let col = colStart; col < colEnd; col++) {
      const char = chars[col];
      const kept = !only || only.includes(char);
      if (kept && char === "█") {
        if (runStart < 0) runStart = col;
        continue;
      }
      flushRun(col);
      if (!kept) continue;
      for (const [rx, ry, rw, rh] of BOX_RECTS[char]) {
        push((col - colStart) * CELL_W + rx, row * CELL_H + ry, rw, rh);
      }
    }
    flushRun(colEnd);
  });
  return out;
}

/** The tight ink box of a rect list — the drawing overruns the nominal grid. */
function bounds(items) {
  const xs = items.flatMap(({ rect: [x, , w] }) => [x, x + w]);
  const ys = items.flatMap(({ rect: [, y, , h] }) => [y, y + h]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Re-proves the table against the file it was measured on. `assets/logo.svg`
 * is the "C" of this same wordmark, hand-written; if the generator still
 * reproduces it rect for rect, no typo has crept into `BOX_RECTS`. The check
 * costs a millisecond and runs every time.
 */
function selfCheck(lines) {
  const svg = readFileSync(LOGO_SVG, "utf8");
  const reference = [...svg.matchAll(/<rect ([^/]*)\/>/g)]
    .map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]+)"/g)].map(([, k, v]) => [k, v])))
    .map((r) => `${+r.x},${+r.y},${+r.width},${+r.height},${r.fill.toLowerCase()}`)
    .sort();

  const c = markRects(lines, { colEnd: 8 });
  const box = bounds(c);
  const generated = c
    .map(({ rect: [x, y, w, h], fill }) => `${x - box.minX},${y - box.minY},${w},${h},${fill}`)
    .sort();

  if (reference.length !== generated.length || reference.some((r, i) => r !== generated[i])) {
    throw new Error(
      `BOX_RECTS ne reproduit plus assets/logo.svg (${generated.length} rects générés contre ${reference.length} de référence)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/**
 * fontkit reads woff2 natively, but `getVariation()` does not survive it: the
 * instance it returns off a WOFF2Font has no `head` table. Hence the
 * decompression pass, kept in memory — nothing is written to disk, since resvg
 * never sees a font at all.
 *
 * Sequentially, never in a `Promise.all`: wawoff2 is an emscripten singleton
 * and concurrent calls corrupt each other.
 */
async function loadFace(path, variation) {
  if (!existsSync(path)) {
    throw new Error(`police introuvable : ${path}\nLancez « pnpm install » avant « pnpm run og:build ».`);
  }
  const face = fontkit.create(Buffer.from(await decompress(readFileSync(path))));
  // Every axis has to be named: `getVariation` leaves an omitted axis at the
  // binary's own default, and Fraunces ships defaulting to wght 900.
  return variation ? face.getVariation(variation) : face;
}

/**
 * Lays a string out and returns it as one `d` plus the advance it consumed.
 *
 * `track` is in pixels, added after every glyph but the last. `snap` rounds
 * the pen onto whole pixels — for the pixel typeface, whose whole point is
 * that its modules land on the raster.
 */
function layoutRun(face, text, size, x, baseline, { track = 0, snap = false } = {}) {
  const scale = size / face.unitsPerEm;
  // Kerning stays on for the serif — CSS letter-spacing sits on top of it, and
  // the card should read like the landing. It comes off for the spaced caps,
  // where kerning and tracking fight and only round positions matter.
  const run = face.layout(text, snap ? { kern: false } : [], "latn", null, "ltr");
  let pen = x;
  let d = "";
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    const gx = pen + pos.xOffset * scale;
    const gy = baseline - pos.yOffset * scale;
    if (glyph.path.commands.length > 0) {
      d += glyph.path.scale(scale, -scale).translate(snap ? Math.round(gx) : gx, gy).toSVG();
    }
    pen += pos.xAdvance * scale + (i < run.glyphs.length - 1 ? track : 0);
  });
  return { d, advance: pen - x };
}

/** The advance a run would consume, without building its path. */
function measureRun(face, text, size, options) {
  return layoutRun(face, text, size, 0, 0, options).advance;
}

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

/**
 * Everything the cards say. The tagline's line breaks are written by hand
 * rather than computed: French runs 76 characters against English's 53, and
 * where a line turns on a card is a typographic decision, not an overflow
 * accident. Two lines in both languages, so the vertical layout is identical.
 */
const CARDS = [
  {
    file: "og.png",
    locale: "en",
    eyebrowAside: "CAESAR · THE ORCHESTRATOR",
    tagline: [
      [{ text: "Delegate coding tasks to external" }],
      [{ text: "agent CLIs — " }, { text: "safely", em: true }, { text: "." }],
    ],
    footerRight: "5 PROVIDERS · 10 MCP TOOLS",
  },
  {
    file: "og-fr.png",
    locale: "fr",
    eyebrowAside: "CAESAR · L'ORCHESTRATEUR",
    tagline: [
      [{ text: "Déléguez des tâches de code à des CLI" }],
      [{ text: "d'agents externes — " }, { text: "en toute sécurité", em: true }, { text: "." }],
    ],
    footerRight: "5 PROVIDERS · 10 OUTILS MCP",
  },
];

const EYEBROW = "§ 01";
const FOOTER_LEFT = "CAESAR.KOUMALABS.ORG";

/** One formatter for every coordinate: `String(0.1 + 0.2)` has no place in a SVG. */
function num(v) {
  return Number(v.toFixed(3)).toString();
}

function rectEl([x, y, w, h], fill, opacity) {
  return (
    `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${fill}"` +
    `${opacity === undefined ? "" : ` fill-opacity="${opacity}"`}/>`
  );
}

function hairline(y) {
  return rectEl([LAYOUT.MARGIN, y, CONTENT_W, 1], HAIRLINE, HAIRLINE_OPACITY);
}

function cardSvg(card, lines, faces) {
  const { W, H, MARGIN, ANNOT_SIZE, ANNOT_TRACK } = LAYOUT;
  const annot = { track: ANNOT_TRACK, snap: true };
  const right = W - MARGIN;

  const pieces = [rectEl([0, 0, W, H], INK_GROUND)];

  const add = (face, text, size, x, baseline, fill, options) => {
    const { d } = layoutRun(face, text, size, x, baseline, options);
    if (d) pieces.push(`<path d="${d}" fill="${fill}"/>`);
  };
  const addRight = (face, text, size, baseline, fill, options) => {
    add(face, text, size, right - measureRun(face, text, size, options), baseline, fill, options);
  };

  add(faces.pixel, EYEBROW, ANNOT_SIZE, MARGIN, LAYOUT.EYEBROW_BASELINE, ACCENT, annot);
  addRight(faces.pixel, card.eyebrowAside, ANNOT_SIZE, LAYOUT.EYEBROW_BASELINE, INK_SECONDARY, annot);
  pieces.push(hairline(LAYOUT.RULE_TOP));

  const mark = markRects(lines, {
    scale: LAYOUT.MARK_SCALE,
    x: LAYOUT.MARK_X,
    y: LAYOUT.MARK_Y,
  });
  for (const { rect, fill } of mark) pieces.push(rectEl(rect, fill));

  const tagTrack = LAYOUT.TAG_SIZE * LAYOUT.TAG_TRACK_EM;
  card.tagline.forEach((runs, row) => {
    const baseline = LAYOUT.TAG_FIRST_BASELINE + row * LAYOUT.TAG_LEADING;
    let pen = MARGIN;
    for (const run of runs) {
      const face = run.em ? faces.italic : faces.roman;
      const { d, advance } = layoutRun(face, run.text, LAYOUT.TAG_SIZE, pen, baseline, { track: tagTrack });
      if (d) pieces.push(`<path d="${d}" fill="${run.em ? ACCENT : INK}"/>`);
      // The pen carries across a style change; kerning deliberately does not,
      // which is the correct typographic behaviour at a font boundary.
      pen += advance + tagTrack;
    }
    const width = pen - tagTrack - MARGIN;
    if (width > CONTENT_W) {
      throw new Error(`[${card.locale}] tagline ligne ${row + 1} : ${Math.ceil(width)} px pour ${CONTENT_W} disponibles`);
    }
  });

  pieces.push(hairline(LAYOUT.RULE_BOT));
  add(faces.pixel, FOOTER_LEFT, ANNOT_SIZE, MARGIN, LAYOUT.FOOTER_BASELINE, INK_FAINT, annot);
  addRight(faces.pixel, card.footerRight, ANNOT_SIZE, LAYOUT.FOOTER_BASELINE, INK_FAINT, annot);

  return svgDoc(W, H, pieces.join(""));
}

/**
 * The square icon: the wordmark's "C" — columns 0 to 7, exactly what
 * `assets/logo.svg` holds — on the ink ground rather than on transparency. A
 * transparent icon vanishes against iOS's dark home screen, and iOS applies
 * its own rounded mask, so none is drawn here.
 *
 * Below 32 px the ANSI Shadow relief is under the resolution and turns to
 * mud, so the smallest frames keep only the solid blocks. That is optical
 * sizing, not a shortcut: a legible full C beats an illegible detailed one.
 */
function iconSvg(size, { padding }) {
  const lines = ICON_LINES;
  const only = size < 32 ? ["█"] : null;
  const raw = markRects(lines, { colEnd: 8, only });
  const box = bounds(raw);
  const inner = size - 2 * padding;
  const scale = inner / box.height;
  const placed = markRects(lines, {
    colEnd: 8,
    only,
    scale,
    x: (size - box.width * scale) / 2 - box.minX * scale,
    y: padding - box.minY * scale,
  });
  return svgDoc(
    size,
    size,
    rectEl([0, 0, size, size], INK_GROUND) + placed.map(({ rect, fill }) => rectEl(rect, fill)).join(""),
  );
}

/** `xmlns` is mandatory: resvg only made it optional in 0.46, well after 0.34. */
function svgDoc(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

let ICON_LINES = null;

// ---------------------------------------------------------------------------
// Rendering and the ICO container
// ---------------------------------------------------------------------------

function renderPng(svg, width, height) {
  const image = new Resvg(svg, {
    // The document already carries width/height/viewBox in pixels, so one user
    // unit is one pixel. Any rescale here would undo the wordmark's whole-pixel
    // alignment, and with it its crispness.
    fitTo: { mode: "original" },
    // No <text> reaches resvg, so fontdb has nothing to do. Off anyway: it is
    // the only thing that could make this machine's font set leak into the
    // output if text ever came back.
    font: { loadSystemFonts: false },
    logLevel: "off",
  }).render();
  if (image.width !== width || image.height !== height) {
    throw new Error(`taille inattendue : ${image.width}×${image.height} au lieu de ${width}×${height}`);
  }
  // asPng un-premultiplies; the raw `.pixels` getter would not.
  return image.asPng();
}

/**
 * An ICO wrapping raw PNGs. The container has allowed it since Vista and every
 * current browser reads it, which means no BMP encoder, no palette, no
 * doubled height, no AND mask — a 6-byte ICONDIR, one 16-byte ICONDIRENTRY per
 * image, then the PNG files verbatim, signature included. All little-endian.
 */
function encodeIco(frames) {
  const dir = Buffer.alloc(6 + 16 * frames.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // 1 = icon
  dir.writeUInt16LE(frames.length, 4);

  let offset = dir.length;
  frames.forEach(({ size, png }, i) => {
    const o = 6 + i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // 0 would mean 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // palette colors — 0 from 8 bpp up
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });

  return Buffer.concat([dir, ...frames.map((f) => f.png)]);
}

// ---------------------------------------------------------------------------

/** Leaves an unchanged file alone, so a no-op run keeps the tree clean. */
function writeIfChanged(path, buffer) {
  const same = existsSync(path) && readFileSync(path).equals(buffer);
  if (!same) writeFileSync(path, buffer);
  console.log(`  ${same ? "inchangé " : "écrit    "} ${path.slice(ROOT.length).padEnd(42)} ${String(buffer.length).padStart(7)} o`);
}

async function main() {
  const lines = readWordmarkLines();
  selfCheck(lines);
  ICON_LINES = lines;

  const faces = {
    pixel: await loadFace(join(STATIC_DIR, "fonts", "GeistPixel-Square.woff2")),
    roman: await loadFace(join(FRAUNCES_DIR, "fraunces-latin-wght-normal.woff2"), { wght: 550 }),
    italic: await loadFace(join(FRAUNCES_DIR, "fraunces-latin-wght-italic.woff2"), { wght: 550 }),
  };

  for (const card of CARDS) {
    writeIfChanged(join(IMG_DIR, card.file), renderPng(cardSvg(card, lines, faces), LAYOUT.W, LAYOUT.H));
  }

  writeIfChanged(join(IMG_DIR, "apple-touch-icon.png"), renderPng(iconSvg(180, { padding: 20 }), 180, 180));

  writeIfChanged(
    join(STATIC_DIR, "favicon.ico"),
    encodeIco(
      [16, 32, 48].map((size) => ({
        size,
        png: renderPng(iconSvg(size, { padding: Math.round(size * 0.12) }), size, size),
      })),
    ),
  );
}

await main();
