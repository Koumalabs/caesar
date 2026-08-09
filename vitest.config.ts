import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    // Les tests d'intégration lancent de vrais CLIs d'agents : ils sont lents.
    testTimeout: 30_000,
  },
});
