/**
 * Version identifiers of the standard. Every exchanged document carries them,
 * so that a reader can cleanly refuse what it does not know how to interpret.
 */
export const TASK_PROTOCOL = "caesar.task/v1" as const;
export const REPORT_PROTOCOL = "caesar.report/v1" as const;
export const EVENT_PROTOCOL = "caesar.event/v1" as const;

/** Global version of the standard, for display and diagnostic purposes. */
export const PROTOCOL_VERSION = "1" as const;

/**
 * Environment variables passed to the child process. An outside agent only
 * needs these to participate: read the task, write the report.
 */
export const ENV = {
  /** Task directory, containing task.json / report.json / events.jsonl. */
  taskDir: "CAESAR_TASK_DIR",
  /** Direct path to the task. */
  taskFile: "CAESAR_TASK_FILE",
  /** Path where the report must be dropped. */
  reportPath: "CAESAR_REPORT_PATH",
  /** Path of the event log, append-only. */
  eventsPath: "CAESAR_EVENTS_PATH",
  /** Task identifier. */
  taskId: "CAESAR_TASK_ID",
  /** Identifier of the executing agent. */
  agent: "CAESAR_AGENT",
  /** Delegation depth, for the anti-recursion guardrail. */
  depth: "CAESAR_DEPTH",
  /** Version of the standard in effect. */
  protocolVersion: "CAESAR_PROTOCOL_VERSION",
} as const;
