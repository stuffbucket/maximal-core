/**
 * Proof that this fixture resolves ONLY through the published `exports` map.
 *
 * Without these, the whole fixture is worthless: if `~/*` or a deep `src/`
 * import resolved here, the "downstream" typecheck would be compiling engine
 * source and would stay green through an exports map that no real consumer
 * could resolve at all.
 *
 * Each specifier below must FAIL to resolve, and each `@ts-expect-error` is
 * placed on the specifier's own line so reformatting cannot silently detach it.
 * `check.ts` backs all of this up from the outside by asserting the resulting
 * tsc program contains no file under the repo's `src/`.
 */

// The root tsconfig maps `~/*` to `./src/*`. This fixture's tsconfig defines no
// `paths` and does not extend the root, so the alias must be meaningless here.
export type ViaRootAlias =
  // @ts-expect-error `~/…` must not resolve outside the root tsconfig.
  import("~/lib/start/boot-status").ReadyLine

// The `exports` map has no "." entry — the package is subpath-only by design.
export type ViaPackageRoot =
  // @ts-expect-error the package root is not an exported entrypoint.
  import("@stuffbucket/maximal-core").ReadyLine

// `files` ships `src/`, so these paths EXIST on disk in a real install. The
// exports map is the only thing stopping a consumer from importing engine
// source and dragging the sidecar's dependency graph into their build.
export type ViaSrc =
  // @ts-expect-error engine source is not an exported subpath.
  import("@stuffbucket/maximal-core/src/lib/live/supervisor").ReadyLine

// Same for reaching the built artifact directly: resolution must go through the
// map's `types`/`import` conditions, not the file layout, or renaming an output
// file silently breaks consumers who bypassed it.
export type ViaDist =
  // @ts-expect-error built output is not an exported subpath.
  import("@stuffbucket/maximal-core/dist/lib/supervisor").ReadyLine

// The impure half of the control contract (engine imports, Hono) is deliberately
// unreachable — importing it is what would trigger a sidecar compile.
export type ViaEngineErrors =
  // @ts-expect-error the engine-coupled error mapper is not an exported subpath.
  import("@stuffbucket/maximal-core/src/lib/jsonrpc/errors").ControlErrorReason
