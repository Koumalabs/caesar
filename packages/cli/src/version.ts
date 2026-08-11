/**
 * La version de l'outil, en un seul endroit.
 *
 * `program.ts` la donne à commander (`orch --version`) et `init.ts` l'affiche
 * sous le logotype : deux lectures du même `package.json` finissaient
 * fatalement par diverger le jour où l'une des deux serait déplacée.
 */
import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;
