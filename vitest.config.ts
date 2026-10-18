import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup/isolate-bible-cache.ts"],
    // Serial: better-sqlite3 + mocks de migration não convivem bem com paralelismo
    // Vitest 5: poolOptions.forks.singleFork removido
    // Mantém isolate:true para não vazar mocks entre arquivos
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    isolate: true,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/db/migrations/**", "src/types/**", "**/*.d.ts"],
      thresholds: {
        statements: 40,
        branches: 40,
        functions: 40,
        lines: 40,
      },
    },
  },
});
