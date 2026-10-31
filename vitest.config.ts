import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["plugins/**/*.test.ts", "dispatch/**/*.test.ts"],
    // The dispatch suites spawn bash and a real Node 24 process per case; 5 s is tight on slow CI.
    // Hooks get the same budget: fixture setup in beforeEach spawns processes too.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
