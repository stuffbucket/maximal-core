import { defineConfig } from "tsup"

// Library build for the consumer surface a UI (or third party) imports:
// the ControlClient SDK, the wire contract, and the shared settings types.
// Bundles JS + .d.ts with the ~/ path aliases resolved, so a plain tsc/bun
// consumer needs no alias config. zod stays external (shared with the consumer).
export default defineConfig({
  entry: {
    client: "src/lib/live/client.ts",
    contract: "src/lib/live/contract.ts",
    "control-contract": "src/lib/jsonrpc/contract.ts",
    supervisor: "src/lib/live/supervisor.ts",
    "settings-types": "src/lib/config/settings-types.ts",
  },
  outDir: "dist/lib",
  format: ["esm"],
  dts: true,
  clean: false,
  external: ["zod"],
  target: "node20",
})
