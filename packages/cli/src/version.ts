/**
 * The tool's version, in a single place.
 *
 * `program.ts` hands it to commander (`caesar --version`) and `init.ts`
 * prints it under the wordmark: two reads of the same `package.json` would
 * fatally end up diverging the day one of the two got moved.
 */
import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;
