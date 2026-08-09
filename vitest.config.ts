import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // `packages/tui` est le seul package du monorepo qui tourne sous Bun
    // (voir son brief) : ses tests importent "bun:test", que vitest/Node ne
    // sait pas résoudre, et certains montent un renderer OpenTUI natif. Ils
    // tournent sous `bun test`, jamais ici.
    exclude: ["**/node_modules/**", "packages/tui/**"],
    environment: "node",
    // Les tests d'intégration lancent de vrais CLIs d'agents : ils sont lents.
    testTimeout: 30_000,
  },
});
