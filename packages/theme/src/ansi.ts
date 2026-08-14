/**
 * Traduction d'une couleur hexadécimale en séquence ANSI, avec dégradation.
 *
 * La palette est exprimée en hexadécimal parce que c'est la seule façon de
 * choisir une teinte : « cyan » ne décrit rien, et c'est pour cela que la
 * ligne de commande n'avait pas de thème mais une suite de choix locaux. Tous
 * les terminaux ne savent pourtant pas rendre 16 millions de couleurs — ce
 * module fait le pont, du plus riche au plus pauvre, sans jamais que
 * l'appelant ait à s'en soucier.
 *
 * Rien ici ne lit `process.env` : l'environnement est toujours passé en
 * paramètre. Ce paquet n'a donc aucune dépendance, pas même sur Node, et
 * chaque niveau de dégradation s'éprouve sans toucher au processus de test.
 */

/** L'environnement dont on déduit les capacités du terminal — `process.env`, ou un objet de test. */
export type Environment = Readonly<Record<string, string | undefined>>;

export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "none";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";

/**
 * Ce que le terminal sait rendre.
 *
 * Délibérément **conservateur** en l'absence de `COLORTERM` : un terminal qui
 * ne l'annonce pas reçoit les 16 couleurs de base. Émettre du 256 à l'aveugle
 * sur un terminal qui l'ignore n'affiche pas une couleur approchée mais la
 * séquence elle-même, en clair, au milieu du texte. Le prix de la prudence
 * est une palette plus grossière sur une session ssh ancienne ; le prix de
 * l'optimisme serait un affichage cassé.
 *
 * `NO_COLOR` prime sur tout (https://no-color.org), de même que `TERM=dumb`,
 * qui décrit un terminal sans aucune séquence de contrôle.
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

/** `#7AA2F7` → `[122, 162, 247]`. Tolère l'absence de `#` et la forme courte `#abc`. */
export function parseHex(hex: string): readonly [number, number, number] {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  // Vérifier la forme plutôt que de se fier à `Number.parseInt`, qui s'arrête
  // au premier caractère invalide sans le signaler : "12345g" lui rendrait
  // 0x12345 en silence, donc une couleur fausse plutôt qu'une erreur.
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Couleur hexadécimale invalide : "${hex}".`);
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Les six paliers de chaque axe du cube 6×6×6 des couleurs 16 à 231. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeIndex(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_LEVELS.length; i += 1) {
    if (Math.abs((CUBE_LEVELS[i] ?? 0) - value) < Math.abs((CUBE_LEVELS[best] ?? 0) - value)) best = i;
  }
  return best;
}

/**
 * Index dans la palette de 256.
 *
 * Deux candidats sont mis en concurrence, et non un seul : le cube 6×6×6
 * (indices 16 à 231) et la rampe de 24 gris (232 à 255). Un demi-ton comme
 * #8992A6 tombe entre deux paliers du cube ; le gris le plus proche lui est
 * souvent plus fidèle. Ne considérer que le cube donnerait un texte
 * secondaire légèrement teinté — de bleu ou de violet pour celui-là.
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

/** Les six secteurs de teinte des couleurs de base, et leur code SGR sombre. */
const HUE_SECTORS: ReadonlyArray<{ center: number; code: number }> = [
  { center: 0, code: 31 }, // rouge
  { center: 60, code: 33 }, // jaune
  { center: 120, code: 32 }, // vert
  { center: 180, code: 36 }, // cyan
  { center: 240, code: 34 }, // bleu
  { center: 300, code: 35 }, // magenta
];

/** Les quatre neutres disponibles, repérés par leur clarté. */
const NEUTRALS: ReadonlyArray<{ lightness: number; code: number }> = [
  { lightness: 0.0, code: 30 }, // noir
  { lightness: 0.5, code: 90 }, // gris (noir vif)
  { lightness: 0.9, code: 37 }, // blanc
  { lightness: 1.0, code: 97 }, // blanc vif
];

/**
 * En dessous, une couleur ne porte plus de teinte identifiable : c'est un
 * neutre, et le rendre en « vert » ou en « bleu » serait faux.
 */
const CHROMA_THRESHOLD = 0.2;

/**
 * Code SGR de la plus proche des 16 couleurs de base — **par la teinte, pas
 * par la distance**.
 *
 * La distance euclidienne dans RGB, qui semble l'évidence, donne ici un
 * résultat absurde : `OK` (#7DCE82, un vert pastel) est numériquement à 6 254
 * du gris moyen et à 32 526 du vert pur. Toute la palette sémantique
 * retomberait donc sur du gris, et le repli à seize couleurs perdrait
 * exactement ce qu'il doit préserver — la distinction entre « autorisé » et
 * « refusé ».
 *
 * On raisonne donc comme l'œil : d'abord la teinte, ensuite la clarté. Une
 * couleur trop peu chromatique pour avoir une teinte est traitée comme un
 * neutre, et choisie sur sa seule clarté.
 *
 * À ce niveau, `DIM` et `FAINT` retombent tous deux sur le gris : la
 * hiérarchie à trois niveaux du thème s'aplatit à deux. C'est la limite de
 * seize couleurs, pas un défaut de la palette — la structure (encadrés,
 * entêtes, retraits) continue de porter la lecture.
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
  // Les variantes vives sont les seules lisibles sur un fond sombre ; au
  // dessus de la mi-clarté, c'est celle qu'on veut.
  return lightness >= 0.5 ? sector.code + 60 : sector.code;
}

/** Séquence d'ouverture pour une couleur d'avant-plan. Chaîne vide si le terminal ne colore pas. */
export function foreground(hex: string, depth: ColorDepth): string {
  if (depth === "none") return "";
  const rgb = parseHex(hex);
  if (depth === "truecolor") return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (depth === "ansi256") return `\x1b[38;5;${toAnsi256(rgb)}m`;
  return `\x1b[${toAnsi16(rgb)}m`;
}

/**
 * Habille `text`. Rend le texte **inchangé** quand rien ne s'applique : pas
 * de séquence vide, pas de `RESET` orphelin — c'est ce qui permet à
 * `--json` et aux tests de comparer des chaînes nues.
 */
export function paint(text: string, style: { hex?: string; bold?: boolean }, depth: ColorDepth): string {
  if (depth === "none") return text;
  const prefix = (style.bold ? BOLD : "") + (style.hex ? foreground(style.hex, depth) : "");
  return prefix === "" ? text : prefix + text + RESET;
}
