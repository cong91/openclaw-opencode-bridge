import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      observability: "src/observability.ts",
      "shared-contracts": "src/shared-contracts.ts",
    },
    format: ["esm"],
    dts: true,
    clean: true,
    splitting: true,
    outDir: "dist/src",
    platform: "node",
    target: "es2022",
  },
  {
    entry: {
      "openclaw-bridge-callback": "opencode-plugin/openclaw-bridge-callback.ts",
    },
    format: ["esm"],
    dts: true,
    clean: false,
    splitting: false,
    outDir: "dist/opencode-plugin",
    platform: "node",
    target: "es2022",
  },
]);
