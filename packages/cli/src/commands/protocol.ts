/**
 * `orch protocol schema [task|report|event]` : publie le JSON Schema du
 * standard `@orch/protocol`. Sans argument, liste les documents disponibles.
 */
import type { SchemaName } from "@orch/protocol";
import { jsonSchemaFor, strictReportJsonSchema } from "@orch/protocol";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_USAGE, printError, printJson, writeLine } from "../output.js";

const DOCUMENTS: readonly SchemaName[] = ["task", "report", "event"];

export interface ProtocolSchemaOptions {
  strict?: boolean;
  json?: boolean;
}

export async function runProtocolSchema(name: string | undefined, options: ProtocolSchemaOptions, io: Io): Promise<number> {
  if (!name) {
    if (options.json) printJson(io, { documents: DOCUMENTS });
    else for (const doc of DOCUMENTS) writeLine(io.stdout, doc);
    return EXIT_OK;
  }

  if (!DOCUMENTS.includes(name as SchemaName)) {
    printError(io, `Document inconnu : "${name}" (attendu l'un de : ${DOCUMENTS.join(", ")}).`);
    return EXIT_USAGE;
  }

  if (options.strict && name !== "report") {
    printError(io, '--strict n\'est disponible que pour "report".');
    return EXIT_USAGE;
  }

  const schema = options.strict ? strictReportJsonSchema() : jsonSchemaFor(name as SchemaName);
  printJson(io, schema);
  return EXIT_OK;
}
