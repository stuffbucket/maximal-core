import config from "@echristian/eslint-config"

// The single-mechanism invariant (ADR-0001): a credential token becomes an
// Authorization / x-api-key header in EXACTLY one file, `src/lib/http/send-request.ts`.
// This rule bans hand-attaching a credential anywhere else, so "one mechanism"
// can't silently regress — a new endpoint that tries to attach its own token
// fails CI and is pushed toward sendRequest().
//
// We ban ATTACHMENT (building the auth value, or naming the auth header), not
// token READS: presence guards (`if (!state.copilotToken)`), fallback
// resolution, and lifecycle writes are all legitimate reads and far too
// numerous to allowlist. The leak vector is a request leaving with a
// hand-attached token.
//
// SHAPES COVERED. Each was probed against a fixture of positives and negatives
// and then against the whole of `src/**`, which yields hits in exactly the
// three files listed in `ignores` and nowhere else:
//
//   `Bearer ${t}` / `token ${t}`   template interpolation
//   "Bearer " + t                  string concatenation
//   { Authorization: v }           object literal, identifier key
//   { "x-api-key": v }             object literal, string key
//   headers.set("x-api-key", v)    Headers setter — also .append()
//   headers["x-api-key"] = v       member assignment — also `.authorization =`
//
// Only the first and the fourth used to be covered. The consequence was that
// `send-request.ts` — the reference implementation this rule exists to make
// unique — attaches via `headers.set(...)` (lines 87/94/104/116/118), a shape
// the guard could not see; any other file could have done the same silently.
// The old rule also carried a dead selector, `Property[key.name='x-api-key']`:
// `x-api-key` is not a valid identifier, so that key is always a string
// literal and `key.name` never exists on it.
//
// SHAPES NOT COVERED, and not coverable by a selector. The rule does not claim
// otherwise and neither do its messages, which say "this shape" rather than
// implying the set is closed:
//
//   - a header name held in a variable:      headers.set(name, value)
//   - a name assembled at runtime:           headers.set("x-" + kind, value)
//   - a record built elsewhere and spread:   fetch(url, { headers: authHeaders })
//   - a credential crossing a function boundary as an opaque
//     Record<string, string> / Headers
//
// Deciding those needs the VALUE of an expression, not its shape; ESLint sees
// only shape. Treat this rule as a tripwire on the common forms, not a proof.
//
// Precision note: the object-literal selectors are scoped to
// `ObjectExpression >` on purpose. Without it they also match ObjectPattern,
// so `const { authorization } = headers` — a read — would fail the build, and a
// rule that fires on legitimate code gets suppressed and then enforces nothing.
//
// `ignores` is exhaustive and minimal: with it emptied, the widened rule hits
// those three files and nothing else in `src/**`. Two entries that used to sit
// here were removed because they no longer named a violation — `src/setup.ts`
// (its smoke test now deliberately sends no x-api-key) and `**/*.test.ts`
// (`files` is `src/**/*.ts`, and there are no tests under `src/`).
const AUTH_HEADER = "/^(?:authorization|x-api-key)$/i"
const ROUTE_HINT =
  "Route the request through sendRequest() with a Credential; the token is attached inside src/lib/http/send-request.ts. See ADR-0001. (This rule matches common attachment SHAPES only — a header name held in a variable, or a header record built elsewhere and spread, is not statically detectable and will not be caught.)"

const tokenAttachmentGuard = {
  name: "credential-attachment-single-mechanism",
  files: ["src/**/*.ts"],
  ignores: [
    // The mechanism itself — the ONE place tokens become auth headers.
    "src/lib/http/send-request.ts",
    // Web-tools sandbox executor forwards a SEPARATE sandbox apiKey (not a
    // GitHub/Copilot token) to the web-tools service. Different credential
    // domain; not yet folded into sendRequest. Tracked as a follow-up.
    "src/routes/messages/web-tools/executor.ts",
    // `--replace` takeover probe. POSTs /_internal/shutdown to the maximal
    // instance already holding the port and attaches the operator's own
    // configured inbound key (`getConfiguredApiKeys()[0]`, via
    // `~/lib/start/port.ts`) as `headers["x-api-key"] = apiKey` on a raw
    // injected fetch. This IS a second hand-rolled attachment site; the
    // widened rule is what surfaced it, and the old rule could not see the
    // member-assignment shape. Scoped down by two facts: the destination is
    // 127.0.0.1 only, and the credential is the proxy's own INBOUND key, not a
    // GitHub/Copilot token. Not folded into sendRequest() because sendRequest
    // infers the credential from the destination host and loopback maps to
    // none. Tracked as a follow-up.
    "src/lib/platform/replace-running.ts",
  ],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "TemplateLiteral > TemplateElement[value.raw=/(?:Bearer |token )$/]",
        message: `Do not hand-build an Authorization value by interpolation. ${ROUTE_HINT}`,
      },
      {
        selector:
          'BinaryExpression[operator="+"][left.value=/(?:Bearer |token )$/]',
        message: `Do not hand-build an Authorization value by concatenation. ${ROUTE_HINT}`,
      },
      {
        selector: `ObjectExpression > Property[key.value=${AUTH_HEADER}]`,
        message: `Do not hand-attach an Authorization / x-api-key header in an object literal. ${ROUTE_HINT}`,
      },
      {
        selector: "ObjectExpression > Property[key.name=/^authorization$/i]",
        message: `Do not hand-attach an Authorization header in an object literal. ${ROUTE_HINT}`,
      },
      {
        selector: `CallExpression[callee.property.name=/^(?:set|append)$/][arguments.0.value=${AUTH_HEADER}]`,
        message: `Do not hand-attach an Authorization / x-api-key header via .set()/.append(). ${ROUTE_HINT}`,
      },
      {
        selector: `AssignmentExpression[left.property.value=${AUTH_HEADER}]`,
        message: `Do not hand-attach an Authorization / x-api-key header by assignment. ${ROUTE_HINT}`,
      },
      {
        selector: "AssignmentExpression[left.property.name=/^authorization$/i]",
        message: `Do not hand-attach an Authorization header by assignment. ${ROUTE_HINT}`,
      },
    ],
  },
}

// Guard the `mock.module()` idiom in tests. Read this before adding a case:
// the rule deliberately does NOT claim to make module mocking safe.
//
// THE MECHANISM (re-measured on Bun 1.3.11, the pin; an earlier revision of this
// comment got it wrong twice and the wrong version is what let #27 ship).
//
// `bun test` INTERLEAVES evaluation and execution — it evaluates one test
// file's module body, runs that file's tests and hooks, then evaluates the next.
// A six-file probe prints `EVAL e → TEST e → AFTERALL e → EVAL f → …`, plain and
// under `--randomize`. So the leak is FORWARD-ONLY (a file evaluated earlier has
// already finished and cannot be affected), and an `afterAll` restore does run
// before the next file is evaluated. The previous claim here — "Bun evaluates
// every test file's module body during startup, so a restore is structurally
// incapable of mattering" — is false and does not reproduce.
//
// What actually breaks a restore is its VALUE, not its timing. `mock.module`
// mutates the live module record IN PLACE, so the namespace object captured with
// `await import(...)` before the install is retroactively updated to hold the
// stub. Restoring from it therefore re-installs the stub:
//
//   const real = await import("./m")
//   await mock.module("./m", () => ({ ...real, TABLE: [] }))  // install: fine
//   await mock.module("./m", () => real)                      // restore: NO-OP
//   await mock.module("./m", () => ({ ...real }))             // restore: NO-OP
//                                                             // (`real` is
//                                                             //  already stubbed)
//
//   const snapshot = { ...(await import("./m")) }   // copy taken BEFORE install
//   await mock.module("./m", () => snapshot)        // restore: WORKS
//
// Measured both directions on the same seed, and in-repo: with the namespace
// form, tests/poll-access-token.test.ts's no-op `sleep` stub reached a later
// sibling on 5 of 12 seeds; with the snapshot form, on 0 of 12. It is NOT that
// `mock.module` refuses a Module Namespace exotic object — installing one works
// fine (probed) — it is that the namespace is live.
//
// This is why rule 4 below exists: the broken shape IS statically detectable.
//
// What is still NOT statically detectable: whether a given `mock.module` call is
// safe. That depends on whether any *other* file evaluated later in the run
// imports the mocked module and when it reads the binding — a property of the
// whole run's module graph, not of the call site. No selector can decide it, and
// the rule does not pretend to. A correct restore is version-dependent hygiene
// (Bun documents no ordering guarantee), never a licence to mock a shared
// module. The durable fix is still a DI seam (`__setServeForTests`,
// `__setBootSecretsForTests`) or using the real module.
//
// What the rule CAN and does enforce, all precision-first:
//
//  1. The fire-and-forget statement forms — `void mock.module(…)` and a bare
//     `mock.module(…)` expression statement. Justification is narrower than it
//     used to be: an unawaited install is not guaranteed to have landed before
//     the same file's next `await import(...)`, so the file can test the real
//     module while believing it tested the stub. It says nothing about leaks.
//
//  2. Stubbing a NON-FUNCTION export with a literal value (array / string /
//     number / boolean / template). PR #27's audit of all 24 `mock.module` sites
//     found every one replaced *function* exports and spread `...real` — except
//     the single site that stubbed a data table (`SECRET_DEFS: []`), and that is
//     the one that caused the outage. The asymmetry is the point: a leaked
//     function stub gets CALLED by the sibling and usually throws or returns an
//     obviously wrong shape, so it fails loudly and near the cause. A leaked
//     empty array is READ silently and yields a plausible wrong answer — here,
//     an empty secrets table made `anthropic-key-precedence` see no
//     `secrets/anthropic` entry. Both leak; only one is quiet.
//
//     Deliberately excluded from the match: object literals. The common shape
//     `default: { ...real.default, unlink: fn }` is a *function* override nested
//     one level down, and four existing sites use it. Flagging object literals
//     would cry wolf on all four, and a rule that cries wolf gets suppressed and
//     then enforces nothing. Precision over coverage — the same bar
//     `tests/docs-reference-parity.test.ts` is held to.
//
//  3. A deny-list of specific modules a sibling is known to read passively, each
//     with a DI seam that replaces the mock. Membership is earned by an incident.
//
//  4. A `mock.module` factory that reads a LIVE module namespace binding
//     (`import * as ns` / `const ns = await import(…)`) — the broken-restore
//     shape above. This one needs scope analysis, not a selector: the *correct*
//     form is also a bare identifier (`() => realRegistry`, where
//     `realRegistry = { ...realRegistryModule }`), so matching on syntax alone
//     would flag every correct restore in the repo and miss the
//     `() => ({ ...ns })` variant, which is broken for the same reason. See
//     `liveNamespaceMockFactory` below.
const MOCK_MODULE_DENY = [
  {
    id: "srvx",
    reason:
      "srvx's `serve` binds real ports; the stub leaks into the real-port WS handshake test (tests/ws/srvx-upgrade-handshake.test.ts) and the restore leaves the live binding half-rewired. Inject the binder via `__setServeForTests` from ~/start instead.",
  },
  {
    id: "~/lib/auth/secrets",
    reason:
      "`SECRET_DEFS` is a shared data table that ~/debug and tests/anthropic-key-precedence.test.ts read passively, so a stub is consumed silently rather than failing. Neutralize the boot step via `__setBootSecretsForTests` from ~/start instead. (This is the mock that caused PR #27's CI-only flake.)",
  },
]

// Rule 4's implementation. A selector cannot express this: the broken shape and
// the correct shape are syntactically identical (`() => ident`) and differ only
// in what `ident` is BOUND to — a live module namespace, or a plain-object copy
// of one. So resolve the binding.
//
// Flagged: any identifier read inside a `mock.module` factory whose declaration
// is `import * as ns from "…"` or `const ns = await import("…")`. Both are live
// namespaces, and `mock.module` mutates the module record in place, so such a
// binding reflects whatever mock is currently installed rather than the real
// module. Using one to restore re-installs the stub (silently — the restore
// still "succeeds"); using one to install is only correct while no mock of that
// module is active, which is not a property the reader can check locally.
//
// Not flagged: `const copy = { ...(await import("…")) }` then `() => copy`, the
// correct form, because `copy`'s declaration is an ObjectExpression.
//
// Scoped to `tests/**` with the rest of the guard. Run against the whole tree it
// reports exactly the sites this convention forbids and nothing else.
/**
 * `Scope.Definition["node"]` is typed `any` by @types/eslint. Narrow it once,
 * here, so the caller stays type-safe.
 * @param {unknown} value
 * @returns {value is import("eslint").Rule.Node}
 */
function isEstreeNode(value) {
  return typeof value === "object" && value !== null && "type" in value
}

/**
 * How `variable` is bound, if it is bound to a live module namespace.
 * @param {import("eslint").Scope.Variable} variable
 * @returns {string | undefined}
 */
function liveNamespaceBinding(variable) {
  for (const def of variable.defs) {
    /** @type {unknown} */
    const node = def.node
    if (!isEstreeNode(node)) continue
    if (node.type === "ImportNamespaceSpecifier") return "import * as"
    if (
      node.type === "VariableDeclarator"
      && node.id.type === "Identifier"
      && node.init?.type === "AwaitExpression"
      && node.init.argument.type === "ImportExpression"
    ) {
      return "await import(…)"
    }
  }
  return undefined
}

/**
 * Every reference made inside `scope` or any scope nested in it.
 * @param {import("eslint").Scope.Scope} scope
 * @param {Array<import("eslint").Scope.Reference>} out
 * @returns {void}
 */
function collectReferences(scope, out) {
  out.push(...scope.references)
  for (const child of scope.childScopes) collectReferences(child, out)
}

/** @type {import("eslint").Rule.RuleModule} */
const liveNamespaceRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a live module namespace binding inside a mock.module factory",
    },
    schema: [],
    messages: {
      liveNamespace:
        "`{{name}}` is a live module namespace (`{{how}}`). `mock.module` mutates the module record in place, so by the time this factory runs `{{name}}` already holds whatever stub is installed — restoring from it re-installs the stub instead of undoing it, which is what shipped in #27. Capture a spread copy before the first install — `const {{name}} = ` then an object literal spreading `await import(…)` — and use that. See docs/dev/testing-strategy.md §5.1.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      /** @param {Extract<import("eslint").Rule.Node, { type: "CallExpression" }>} node */
      "CallExpression[callee.object.name='mock'][callee.property.name='module']"(
        node,
      ) {
        const factory = node.arguments.at(1)
        if (
          factory?.type !== "ArrowFunctionExpression"
          && factory?.type !== "FunctionExpression"
        ) {
          return
        }
        /** @type {Array<import("eslint").Scope.Reference>} */
        const references = []
        collectReferences(sourceCode.getScope(factory), references)
        for (const ref of references) {
          if (!ref.isRead() || !ref.resolved) continue
          const how = liveNamespaceBinding(ref.resolved)
          if (how === undefined) continue
          context.report({
            node: ref.identifier,
            messageId: "liveNamespace",
            data: { name: ref.identifier.name, how },
          })
        }
      },
    }
  },
}

const mockModuleLeakGuard = {
  name: "no-unrestored-mock-module",
  files: ["tests/**/*.ts"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          'ExpressionStatement > UnaryExpression[operator="void"] > CallExpression[callee.object.name="mock"][callee.property.name="module"]',
        message:
          "`void mock.module(...)` is not guaranteed to have landed before this file's next `await import(...)`, so the file may exercise the real module while believing it stubbed one. `await` it. Note that awaiting does NOT stop the stub leaking into files evaluated later in the run; an `afterAll` restore does run before the next file is evaluated on Bun 1.3.11, but only if it hands back a snapshot captured BEFORE the install (`mock.module` mutates the live namespace in place). Use a DI seam or the real module for anything shared.",
      },
      {
        selector:
          'ExpressionStatement > CallExpression[callee.object.name="mock"][callee.property.name="module"]',
        message:
          "Unawaited `mock.module(...)` is not guaranteed to have landed before this file's next `await import(...)`. `await` it. Awaiting does not by itself prevent cross-file leakage — the stub reaches every file evaluated after this one unless the restore hands back a pre-install snapshot (`mock.module` mutates the live namespace in place, so restoring from it re-installs the stub). Use a DI seam or the real module for anything shared.",
      },
      {
        selector:
          'CallExpression[callee.object.name="mock"][callee.property.name="module"] > ArrowFunctionExpression > ObjectExpression > Property:matches([value.type="ArrayExpression"], [value.type="Literal"], [value.type="TemplateLiteral"])',
        message:
          "Do not stub a non-function export with `mock.module`. A module mock reaches every file evaluated after this one; a leaked *function* stub gets called and fails loudly, but a leaked *data* export is read silently and yields a plausible wrong answer — that is exactly how `SECRET_DEFS: []` broke a sibling in PR #27. Expose a DI seam for the value instead.",
      },
      ...MOCK_MODULE_DENY.map((entry) => ({
        selector: `CallExpression[callee.object.name="mock"][callee.property.name="module"][arguments.0.value="${entry.id}"]`,
        message: `Do not \`mock.module("${entry.id}", …)\` in any form. ${entry.reason}`,
      })),
    ],
    "maximal/no-live-namespace-mock-factory": "error",
  },
  plugins: {
    maximal: { rules: { "no-live-namespace-mock-factory": liveNamespaceRule } },
  },
}

export default [
  ...config({
    // Every entry here must name something that EXISTS in this repo. Ignores
    // for absent trees (`.opencode/**`, `contrib/**`, `shell/**`, `site/**`,
    // `landing/**` — all inherited from the pre-split repo) read as policy and
    // enforce nothing; they were removed. Verify with `ls` before adding one.
    ignores: [
      "docs/**",
      "scripts/**",
      // The downstream contract fixture is compiled by its OWN tsconfig, on
      // purpose: it must not resolve the root's `~/*` -> src/* alias, or it
      // would typecheck against engine source instead of the published
      // exports map and pass with the contract broken. That isolation means
      // the root project cannot type these files, so type-aware rules see
      // every value as `error`-typed. `downstream/check.ts` (the runner) IS
      // in the root project and stays linted.
      "downstream/src/**",
      ".dependency-cruiser.cjs",
    ],
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  }),
  tokenAttachmentGuard,
  mockModuleLeakGuard,
]
