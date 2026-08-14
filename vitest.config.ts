import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // `packages/tui` is the only package in the monorepo that runs under Bun
    // (see its brief): its tests import "bun:test", which vitest/Node cannot
    // resolve, and some of them mount a native OpenTUI renderer. They run
    // under `bun test`, never here.
    exclude: ["**/node_modules/**", "packages/tui/**"],
    environment: "node",
    // Integration tests launch real agent CLIs: they are slow.
    testTimeout: 30_000,
  },
});
