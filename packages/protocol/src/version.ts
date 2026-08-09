/**
 * Identifiants de version du standard. Chaque document échangé les porte, afin
 * qu'un lecteur puisse refuser proprement ce qu'il ne sait pas interpréter.
 */
export const TASK_PROTOCOL = "orch.task/v1" as const;
export const REPORT_PROTOCOL = "orch.report/v1" as const;
export const EVENT_PROTOCOL = "orch.event/v1" as const;

/** Version globale du standard, à des fins d'affichage et de diagnostic. */
export const PROTOCOL_VERSION = "1" as const;

/**
 * Variables d'environnement transmises au processus fils. Un agent extérieur
 * n'a besoin que de celles-ci pour participer : lire la mission, écrire le rapport.
 */
export const ENV = {
  /** Répertoire de la tâche, contenant task.json / report.json / events.jsonl. */
  taskDir: "ORCH_TASK_DIR",
  /** Chemin direct de la mission. */
  taskFile: "ORCH_TASK_FILE",
  /** Chemin où déposer le rapport. */
  reportPath: "ORCH_REPORT_PATH",
  /** Chemin du journal d'événements, en append-only. */
  eventsPath: "ORCH_EVENTS_PATH",
  /** Identifiant de la tâche. */
  taskId: "ORCH_TASK_ID",
  /** Identifiant de l'agent qui exécute. */
  agent: "ORCH_AGENT",
  /** Profondeur de délégation, pour le garde-fou anti-récursion. */
  depth: "ORCH_DEPTH",
  /** Version du standard en vigueur. */
  protocolVersion: "ORCH_PROTOCOL_VERSION",
} as const;
