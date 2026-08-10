import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENV, PROTOCOL_VERSION, REPORT_PROTOCOL } from "./version.js";
import { TaskSchema, type Task } from "./task.js";
import { ReportSchema, type Report } from "./report.js";
import { EventSchema, type OrchEvent } from "./event.js";

export interface TaskPaths {
  dir: string;
  taskFile: string;
  reportPath: string;
  eventsPath: string;
  rawLog: string;
}

/** Disposition normalisée d'un répertoire de tâche. */
export function taskPaths(taskDir: string): TaskPaths {
  return {
    dir: taskDir,
    taskFile: join(taskDir, "task.json"),
    reportPath: join(taskDir, "report.json"),
    eventsPath: join(taskDir, "events.jsonl"),
    rawLog: join(taskDir, "raw.log"),
  };
}

/**
 * Les variables d'environnement d'un sous-agent. C'est le contrat minimal :
 * un agent extérieur qui sait lire `$ORCH_TASK_FILE` et écrire `$ORCH_REPORT_PATH`
 * est orchestrable, sans rien connaître de cette implémentation.
 */
export function taskEnv(task: Task, paths: TaskPaths): Record<string, string> {
  return {
    [ENV.taskDir]: paths.dir,
    [ENV.taskFile]: paths.taskFile,
    [ENV.reportPath]: paths.reportPath,
    [ENV.eventsPath]: paths.eventsPath,
    [ENV.taskId]: task.id,
    [ENV.agent]: task.agent,
    [ENV.depth]: String(task.depth),
    [ENV.protocolVersion]: PROTOCOL_VERSION,
  };
}

export async function writeTask(paths: TaskPaths, task: Task): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.taskFile, JSON.stringify(task, null, 2) + "\n", "utf8");
}

export async function readTask(paths: TaskPaths): Promise<Task> {
  const raw = await readFile(paths.taskFile, "utf8");
  return TaskSchema.parse(JSON.parse(raw));
}

export async function appendEvent(paths: TaskPaths, event: OrchEvent): Promise<void> {
  await mkdir(dirname(paths.eventsPath), { recursive: true });
  await appendFile(paths.eventsPath, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Relit le journal en ignorant les lignes illisibles : un journal partiellement
 * corrompu reste plus utile qu'une erreur.
 */
export async function readEvents(paths: TaskPaths): Promise<OrchEvent[]> {
  let raw: string;
  try {
    raw = await readFile(paths.eventsPath, "utf8");
  } catch {
    return [];
  }
  const events: OrchEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = EventSchema.safeParse(safeJsonParse(line));
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

/**
 * Ramène tout `null` à un champ absent, récursivement.
 *
 * Le standard dit « facultatif = absent », mais les sorties structurées natives
 * imposent l'inverse : leur mode strict exige que `required` couvre toutes les
 * propriétés, si bien qu'un champ facultatif s'y déclare nullable et revient
 * rempli d'un `null` explicite (voir `strictReportJsonSchema` dans
 * `jsonschema.ts`). Sans cette normalisation, un `"usage": null` parfaitement
 * légitime ferait échouer la validation d'un rapport par ailleurs impeccable, et
 * l'orchestrateur retomberait sur un palier dégradé pour rien.
 *
 * Les tableaux sont parcourus mais leurs éléments conservés tels quels : un
 * `null` y est une valeur, pas un champ omis.
 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) continue;
    out[key] = dropNulls(item);
  }
  return out;
}

/** Valide un rapport, quelle que soit sa provenance. */
export function parseReport(value: unknown): Report {
  return ReportSchema.parse(dropNulls(value));
}

/** Lit `report.json` s'il existe et s'il est conforme. */
export async function readReport(paths: TaskPaths): Promise<Report | null> {
  try {
    const raw = await readFile(paths.reportPath, "utf8");
    const parsed = ReportSchema.safeParse(dropNulls(safeJsonParse(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeReport(paths: TaskPaths, report: Report): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

/**
 * Dernier recours : retrouver un rapport noyé dans la sortie texte d'un agent.
 *
 * On cherche d'abord un bloc explicitement balisé, puis, à défaut, n'importe quel
 * objet JSON du texte qui se déclare comme un rapport. Le balayage suit les
 * accolades en tenant compte des chaînes et des échappements, afin de ne pas se
 * faire piéger par une accolade à l'intérieur d'une chaîne.
 */
export function extractReportFromText(text: string): Report | null {
  const candidates: string[] = [];

  // Blocs de code balisés : ```json orch:report, ```orch:report, ```json …
  const fence = /```[ \t]*(?:json)?[ \t]*(?:orch:report)?[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const body = match[1];
    if (body && body.includes(REPORT_PROTOCOL)) candidates.push(body);
  }

  // Objets JSON bruts contenant le marqueur de protocole.
  for (const start of markerObjectStarts(text)) {
    const obj = readBalancedObject(text, start);
    if (obj) candidates.push(obj);
  }

  // Le dernier rapport valide l'emporte : un agent qui se reprend a le dernier mot.
  for (const candidate of candidates.reverse()) {
    const parsed = ReportSchema.safeParse(dropNulls(safeJsonParse(candidate)));
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Positions d'ouverture d'objet plausibles, remontées depuis chaque marqueur
 * trouvé — voir I1 de la revue finale. Ne retenir que la première `{`
 * rencontrée en arrière perdait un rapport pourtant valide dès qu'un objet
 * imbriqué précédait le champ `protocol` dans le même objet (p. ex.
 * `changes[0]` avant `protocol`, en fin de rapport) : c'est alors l'accolade
 * de cet objet imbriqué qui était prise, jamais celle du rapport lui-même.
 * Toutes les positions d'ouverture avant chaque marqueur sont donc
 * collectées, pour être essayées de la plus proche à la plus lointaine par
 * `extractReportFromText` — l'ordre de la valeur de retour ci-dessous est
 * délibérément inversé (le plus loin en premier) : `extractReportFromText`
 * relit ses candidats via `.reverse()` pour que la dernière occurrence du
 * marqueur l'emporte (un agent qui se reprend a le dernier mot) ; les
 * empiler ici du plus loin au plus proche est ce qui fait qu'après ce
 * `reverse()` global, les candidats d'une même occurrence ressortent bien
 * du plus proche au plus lointain, sans perdre l'ordre entre occurrences.
 */
function markerObjectStarts(text: string): number[] {
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const marker = text.indexOf(REPORT_PROTOCOL, from);
    if (marker === -1) break;
    from = marker + REPORT_PROTOCOL.length;
    const forThisMarker: number[] = [];
    for (let i = marker; i >= 0; i--) {
      if (text[i] === "{") forThisMarker.push(i);
    }
    starts.push(...forThisMarker.reverse());
  }
  return starts;
}

function readBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
