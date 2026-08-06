/** @type {import('dependency-cruiser').IConfiguration} */
//
// This config is NOT run directly. `bun run deps:check` runs
// `scripts/check-deps.ts`, which cruises with this config and then applies a
// ratchet to `no-circular`; `check:deep` and ci.yml both go through that script.
// Running `depcruise --config .dependency-cruiser.cjs src tests` by hand exits
// non-zero on the standing circular backlog, which is correct and is why the
// gate is the script.
//
// WHAT FAILS A BUILD. All three `error` rules below. `not-to-test` and
// `no-route-imports-from-lib-or-services` are absolute. `no-circular` is
// ratcheted: the set of imports that close a cycle is recorded in
// scripts/check-deps.ts and may only shrink — a new one fails, and fixing one
// fails until the record is updated. `no-orphans` is the only advisory rule and
// currently matches nothing.
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle is a defect, so this is `error` — but there is a standing " +
        "backlog, so the gate is `bun run deps:check` (scripts/check-deps.ts), " +
        "which holds the known set and fails on any addition to it. Break cycles " +
        "by extracting the shared type/helper into a module both sides import. " +
        "`bun run deps:check --list` shows what is left, grouped by component; " +
        "when it reaches zero, delete the ratchet and this rule stands alone.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "ADVISORY, NOT A GATE. Orphan modules (not reachable " +
        "from any entry) are typically dead code. Either wire them up or delete " +
        "them. Currently matches nothing.",
      from: {
        orphan: true,
        // Only patterns that can still match something in this repo. The
        // previous list also excused `tsdown.config.*`, `src/lib/build-info.gen.ts`,
        // `src/pages/usage-viewer.gen.ts` and `src/pages/**` — none of which
        // exist here (this repo is headless; there is no `src/pages`). Removing
        // them was verified to produce byte-identical depcruise output.
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|cts|mts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
        ],
      },
      to: {},
    },
    {
      name: "not-to-test",
      severity: "error",
      comment:
        "Production code should not depend on test fixtures or specs.",
      from: { pathNot: "^(tests|src/.+\\.test\\.ts$)" },
      to: { path: "^(tests|src/.+\\.test\\.ts$)" },
    },
    {
      name: "no-route-imports-from-lib-or-services",
      severity: "error",
      comment:
        "Layering rule: routes -> services -> lib. Modules under src/lib and " +
        "src/services must not import from src/routes. (Previously cited as " +
        "'per CLAUDE.md'; no such rule is written in CLAUDE.md or AGENTS.md — " +
        "this config is the only place the layering is stated, so it is stated " +
        "here in full.)",
      from: { path: "^src/(lib|services)/" },
      to: { path: "^src/routes/" },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules"],
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)",
      },
      archi: {
        collapsePattern:
          "^(?:packages|src|lib|app|bin|test(?:s?)|spec(?:s?))/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)",
      },
    },
  },
}
