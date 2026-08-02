import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Pure, unit-testable logic only.
      // extension.ts + wasmRunner.ts are VS Code/WASM host glue verified via F5
      // (@vscode/test-electron would be needed for integration tests).
      include: ["src/ottl/**"],
      exclude: ["src/ottl/**/*.test.ts", "src/ottl/wasmRunner.ts"],
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90
      }
    }
  }
});
