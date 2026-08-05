/** @type {import('dependency-cruiser').IConfiguration} */
//
// Run by `bun run deps:check`, which is wired into `check:deep` and into
// ci.yml. Until this PR nothing invoked it at all: the config was correct and
// enforced nothing, because no chain and no workflow ever ran depcruise.
//
// WHAT ACTUALLY FAILS A BUILD. Only the two `error` rules below. depcruise
// exits 2 when an `error` rule matches and 0 when only `warn` rules do, so a
// green `deps:check` means "no layering violation" — it does NOT mean "no
// cycles". `no-circular` currently matches 47 times and is advisory; do not
// read its silence as absence, read the output.
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "warn",
      comment:
        "ADVISORY, NOT A GATE — 47 standing violations as of v0.4.0, and `warn` " +
        "does not affect depcruise's exit code. Circular dependencies make code " +
        "hard to reason about and refactor. Break cycles by extracting shared " +
        "types/helpers. Promoting this to `error` requires clearing the backlog " +
        "first (or adopting a `--ignore-known` baseline).",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "ADVISORY, NOT A GATE — see no-circular. Orphan modules (not reachable " +
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
