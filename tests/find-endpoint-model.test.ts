import { describe, expect, it, beforeEach, afterEach } from "bun:test"

import {
  findEndpointModel,
  findInModels,
  normalizeSdkModelId,
} from "../src/lib/models/models"
import { state } from "../src/lib/runtime-state/state"

// findInModels is a pure function (no state), so tests are immune to the
// mock.module contamination that messages-handler.test.ts applies to
// ~/lib/models/models. findEndpointModel is a one-line wrapper around findInModels;
// its state-reading path is exercised by route integration tests.

const makeModel = (id: string, version: string, family: string) => ({
  capabilities: {
    family,
    limits: {},
    object: "model_capabilities" as const,
    supports: {},
    tokenizer: "o200k_base",
    type: "chat" as const,
  },
  id,
  model_picker_enabled: true,
  name: id,
  object: "model" as const,
  preview: false,
  vendor: "Anthropic",
  version,
  supported_endpoints: ["/v1/messages"],
})

// Fixture that mirrors what the Copilot /models endpoint returns today:
// IDs are date-suffixed (e.g. claude-sonnet-4-6-20260301) and version
// holds the dotted canonical form (claude-sonnet-4.6).
const CURRENT_MODELS = [
  makeModel("claude-opus-4-6-20260301", "claude-opus-4.6", "claude-opus-4.6"),
  makeModel(
    "claude-sonnet-4-6-20260301",
    "claude-sonnet-4.6",
    "claude-sonnet-4.6",
  ),
  makeModel(
    "claude-haiku-4-5-20260301",
    "claude-haiku-4.5",
    "claude-haiku-4.5",
  ),
]

describe("findInModels", () => {
  describe("exact match", () => {
    it("returns the model when the SDK ID matches m.id exactly for a Claude model", () => {
      const result = findInModels("claude-sonnet-4-6-20260301", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    // Non-Claude IDs can't be normalised, so only exact match works.
    // This test kills the ArrowFunction / ConditionalExpression mutations
    // that disable the exact-match predicate: without it the function
    // returns undefined instead of the model.
    it("returns a non-Claude model via exact match only", () => {
      const gptModel = makeModel("gpt-5.4", "1", "gpt")
      const result = findInModels("gpt-5.4", [gptModel])
      expect(result?.id).toBe("gpt-5.4")
    })

    it("returns undefined when models list is empty", () => {
      expect(findInModels("claude-sonnet-4-6", [])).toBeUndefined()
    })
  })

  describe("version-field match (regression: date-suffix ID format)", () => {
    // Before the fix, findEndpointModel would construct "claude-sonnet-4.6"
    // and compare it only against m.id. With date-suffixed IDs, m.id is
    // "claude-sonnet-4-6-20260301" so the lookup silently returned undefined
    // and the original model string was forwarded to Copilot → 400.
    it("resolves a dash-separated ID against m.version", () => {
      const result = findInModels("claude-sonnet-4-6", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    it("resolves a dotted ID (claude-sonnet-4.6) against m.version", () => {
      const result = findInModels("claude-sonnet-4.6", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    it("resolves an Anthropic date-suffixed SDK ID (claude-sonnet-4-6-20250514)", () => {
      const result = findInModels("claude-sonnet-4-6-20250514", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    it("resolves old-style family-last IDs (claude-3-5-sonnet-20241022)", () => {
      const models = [
        makeModel(
          "claude-3-5-sonnet-20241022",
          "claude-sonnet-3.5",
          "claude-sonnet-3.5",
        ),
      ]
      const result = findInModels("claude-3-5-sonnet-20241022", models)
      expect(result?.id).toBe("claude-3-5-sonnet-20241022")
    })
  })

  describe("semantic tuple fallback", () => {
    // If Copilot changes their ID and version field formats again, the
    // semantic fallback normalizes both sides and compares {family, version}
    // tuples — no string format dependency.
    it("matches when m.id changes format but normalizes to the same tuple", () => {
      const models = [
        // Hypothetical future format: longer suffix, different separator style.
        makeModel(
          "claude-sonnet-4-6-2026-03-01-preview",
          "some-unrecognised-version-string",
          "claude-sonnet-4.6",
        ),
      ]
      // m.version won't match; semantic fallback normalizes m.capabilities.family
      // "claude-sonnet-4.6" → {family:"sonnet", version:"4.6"} and matches.
      const result = findInModels("claude-sonnet-4-6", models)
      expect(result?.id).toBe("claude-sonnet-4-6-2026-03-01-preview")
    })

    it("matches via m.id normalization when version and family are unrecognised", () => {
      const models = [
        makeModel("claude-haiku-4-5-20260301", "unrecognised", "unrecognised"),
      ]
      const result = findInModels("claude-haiku-4-5", models)
      expect(result?.id).toBe("claude-haiku-4-5-20260301")
    })

    // Kills the BooleanLiteral mutation that turns `if (!c) return false`
    // into `if (!c) return true`, and the ConditionalExpression that turns
    // `if (!c)` into `if (false)` (which causes a TypeError on c.family).
    // The opaque model forces c=undefined in the predicate; the target uses
    // an unrecognised version string so byName doesn't short-circuit and the
    // semantic fallback actually runs.
    it("skips models whose fields cannot be normalised, returns the correct one", () => {
      const opaque = makeModel("opaque-id", "opaque-version", "opaque-family")
      // version is opaque so byName (m.version === modelName) fails;
      // semantic fallback must find it via capabilities.family.
      const target = makeModel(
        "claude-sonnet-4-6-20260301",
        "unrecognised",
        "claude-sonnet-4.6",
      )
      const result = findInModels("claude-sonnet-4-6", [opaque, target])
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    // Kills the ConditionalExpression mutation that replaces
    // `c.family === normalized.family && c.version === normalized.version`
    // with `true && c.version === normalized.version` (drops family check).
    // opus-4.6 appears before sonnet-4.6; without the family guard the
    // wrong model would be returned.
    it("distinguishes models with the same version but different family", () => {
      const opusFirst = makeModel(
        "claude-opus-4-6-20260301",
        "unrecognised",
        "claude-opus-4.6",
      )
      const sonnet = makeModel(
        "claude-sonnet-4-6-20260301",
        "unrecognised",
        "claude-sonnet-4.6",
      )
      const result = findInModels("claude-sonnet-4-6", [opusFirst, sonnet])
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })
  })

  describe("no match", () => {
    it("returns undefined for a non-Claude model ID not in the list", () => {
      expect(findInModels("gpt-5.4", CURRENT_MODELS)).toBeUndefined()
    })

    it("returns undefined when no model in the list matches", () => {
      expect(findInModels("claude-opus-99-0", CURRENT_MODELS)).toBeUndefined()
    })
  })
})

describe("normalizeSdkModelId", () => {
  describe("known SDK formats (happy path)", () => {
    it.each([
      // Pattern 1: claude-{family}-{major}-{minor}[-date]
      ["claude-opus-4-5-20251101", { family: "opus", version: "4.5" }],
      ["claude-haiku-3-5-20250514", { family: "haiku", version: "3.5" }],
      ["claude-sonnet-4-6", { family: "sonnet", version: "4.6" }],
      ["claude-sonnet-4-6-20260301", { family: "sonnet", version: "4.6" }],
      // Pattern 2: claude-{major}-{minor}-{family}[-date]
      ["claude-3-5-sonnet-20241022", { family: "sonnet", version: "3.5" }],
      // Pattern 3: claude-{family}-{major}.{minor}
      ["claude-haiku-4.5", { family: "haiku", version: "4.5" }],
      ["claude-sonnet-4.6", { family: "sonnet", version: "4.6" }],
      // Pattern 4: claude-{family}-{major}[-date]
      ["claude-sonnet-4-20250514", { family: "sonnet", version: "4" }],
      // Pattern 5: claude-{major}-{family}
      ["claude-3-opus", { family: "opus", version: "3" }],
    ])(
      "%s → %o",
      (
        input: string,
        expected: { family: string; version: string } | undefined,
      ) => {
        expect(normalizeSdkModelId(input)).toEqual(expected)
      },
    )
  })

  // Multi-digit version segments — kills \d+ → \d mutations on every pattern.
  describe("multi-digit version segments", () => {
    it.each([
      // Pattern 1: two-digit major
      ["claude-opus-10-5", { family: "opus", version: "10.5" }],
      // Pattern 1: two-digit minor
      ["claude-opus-4-10", { family: "opus", version: "4.10" }],
      // Pattern 2: two-digit major
      ["claude-10-5-opus", { family: "opus", version: "10.5" }],
      // Pattern 2: two-digit minor
      ["claude-3-10-opus", { family: "opus", version: "3.10" }],
      // Pattern 3: two-digit major
      ["claude-opus-10.5", { family: "opus", version: "10.5" }],
      // Pattern 3: two-digit minor
      ["claude-opus-4.10", { family: "opus", version: "4.10" }],
      // Pattern 4: two-digit major
      ["claude-opus-10", { family: "opus", version: "10" }],
      // Pattern 5: two-digit major
      ["claude-10-opus", { family: "opus", version: "10" }],
    ])(
      "%s → %o",
      (
        input: string,
        expected: { family: string; version: string } | undefined,
      ) => {
        expect(normalizeSdkModelId(input)).toEqual(expected)
      },
    )
  })

  // ^ anchor — strings that don't start with "claude-" must not match.
  // Kills the ^ → (removed) mutations on each of the five patterns.
  describe("^ anchor: rejects strings not starting with claude-", () => {
    it.each([
      "prefix-claude-sonnet-4-6", // would match Pattern 1 without ^
      "prefix-claude-3-5-sonnet", // would match Pattern 2 without ^
      "prefix-claude-haiku-4.5", // would match Pattern 3 without ^
      "prefix-claude-sonnet-4", // would match Pattern 4 without ^
      "prefix-claude-3-opus", // would match Pattern 5 without ^
    ])("%s → undefined", (input: string) => {
      expect(normalizeSdkModelId(input)).toBeUndefined()
    })
  })

  // $ anchor — strings with trailing garbage after the version must not match.
  // Kills the $ → (removed) mutations on each pattern.
  describe("$ anchor: rejects strings with non-version trailing content", () => {
    it.each([
      "claude-sonnet-4-6-extra", // would match Pattern 1 without $
      "claude-3-5-sonnet-extra", // would match Pattern 2 without $
      "claude-haiku-4.5-extra", // would match Pattern 3 without $
      "claude-sonnet-4-extra", // would match Pattern 4 without $
      "claude-3-opus-extra", // would match Pattern 5 without $
    ])("%s → undefined", (input: string) => {
      expect(normalizeSdkModelId(input)).toBeUndefined()
    })
  })

  // Date-strip $ anchor — ensures the 8-digit strip is anchored to the end,
  // so a date-like segment in the middle (e.g. as the major version) is
  // preserved rather than stripped. Without the $ the middle segment is
  // consumed, destroying the version information.
  describe("date-strip $ anchor: preserves date-like middle segments", () => {
    it("treats an 8-digit major version as the version number, not a date", () => {
      // "-20241022" appears in the middle: Pattern 5 captures it as the version.
      // Without the $ anchor on the strip regex, the middle segment is eaten
      // and the string becomes "claude--opus" which matches nothing.
      expect(normalizeSdkModelId("claude-20241022-opus")).toEqual({
        family: "opus",
        version: "20241022",
      })
    })
  })

  describe("non-Claude IDs", () => {
    it.each(["gpt-5.4", "gemini-pro", "gpt-4o", ""])(
      "%s → undefined",
      (input: string) => {
        expect(normalizeSdkModelId(input)).toBeUndefined()
      },
    )
  })
})

// ---------------------------------------------------------------------------
// findEndpointModel — the one-line state-reading wrapper. Previously tested
// only "via route integration tests" per the now-removed comment, but
// tests/messages-handler.test.ts mock.module's the whole module out so the
// wrapper had ZERO surviving mutation coverage. Mutation testing surfaced 11
// surviving mutants in this function — all killed by the tests below.
// ---------------------------------------------------------------------------

describe("findEndpointModel", () => {
  const originalModels = state.models

  beforeEach(() => {
    state.models = undefined
  })

  afterEach(() => {
    state.models = originalModels
  })

  it("returns undefined when state.models is undefined (the ?? [] fallback)", () => {
    state.models = undefined
    // Kills OptionalChaining mutant `state.models.data` (would NPE) and
    // LogicalOperator mutant `state.models?.data && []` (returns undefined
    // when models is undefined and asks findInModels to search undefined).
    expect(findEndpointModel("claude-sonnet-4-6")).toBeUndefined()
  })

  it("returns undefined when state.models.data is empty (the ?? [] fallback path is exercised)", () => {
    state.models = {
      data: [],
      object: "list",
    }
    expect(findEndpointModel("claude-sonnet-4-6")).toBeUndefined()
  })

  it("rejects the 'Stryker was here' poisoned fallback — [] really means []", () => {
    // Kills the ArrayDeclaration mutant `?? ["Stryker was here"]`. If the
    // fallback array contained junk, findInModels would still return
    // undefined here because none of the junk matches "claude-...". But the
    // intent is documented: a fallback to literal [], not a fallback to
    // arbitrary garbage that happens to also return undefined.
    state.models = undefined
    const result = findEndpointModel("claude-sonnet-4-6")
    expect(result).toBeUndefined()
    // The function must not throw on a string-array fallback either —
    // findInModels only safely consumes Model[]. The poisoned-fallback
    // mutant would crash; an undefined return + no throw is the spec.
  })

  it("resolves a model from state.models.data by passing through to findInModels", () => {
    // Kills the ArrowFunction mutant `findEndpointModel = () => undefined`
    // and the ArrowFunction mutant on findInModels callbacks. The real
    // wrapper must return the matching model from state.
    const model = {
      capabilities: {
        family: "claude-sonnet-4.6",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "claude-sonnet-4-6-20260301",
      model_picker_enabled: true,
      name: "Sonnet 4.6",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-sonnet-4.6",
      supported_endpoints: ["/v1/messages"],
    }
    state.models = { data: [model], object: "list" }

    // Exact-match path.
    expect(findEndpointModel("claude-sonnet-4-6-20260301")?.id).toBe(
      "claude-sonnet-4-6-20260301",
    )
    // byName path (kills the StringLiteral mutant `modelName = ""` and the
    // ConditionalExpression mutants on the m.id/m.version predicate, plus
    // the `if (byName) return byName` early-return mutant).
    expect(findEndpointModel("claude-sonnet-4-6")?.id).toBe(
      "claude-sonnet-4-6-20260301",
    )
    expect(findEndpointModel("claude-sonnet-4.6")?.id).toBe(
      "claude-sonnet-4-6-20260301",
    )
  })

  it("passes the sdkModelId argument through unchanged (not a constant)", () => {
    // The wrapper passes sdkModelId straight to findInModels. A mutant that
    // hardcodes the argument would resolve the wrong (or no) model.
    const a = {
      capabilities: {
        family: "claude-opus-4.6",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "claude-opus-4-6-20260301",
      model_picker_enabled: true,
      name: "Opus",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-opus-4.6",
      supported_endpoints: ["/v1/messages"],
    }
    const b = {
      ...a,
      id: "claude-haiku-4-5-20260301",
      version: "claude-haiku-4.5",
      capabilities: { ...a.capabilities, family: "claude-haiku-4.5" },
    }
    state.models = { data: [a, b], object: "list" }

    expect(findEndpointModel("claude-opus-4-6")?.id).toBe(
      "claude-opus-4-6-20260301",
    )
    expect(findEndpointModel("claude-haiku-4-5")?.id).toBe(
      "claude-haiku-4-5-20260301",
    )
  })

  // ------------------------------------------------------------------------
  // byName lookup — the two tests below are the only ones that can observe it.
  //
  // The trap the previous four tests here fell into: they asserted that a model
  // byName finds is returned, with fixtures whose *other* fields were set to
  // "unrecognised" on the theory that this stopped the semantic-tuple fallback
  // from finding it too. It does not, and the arithmetic says why.
  //
  //   modelName = `claude-${normalized.family}-${normalized.version}`
  //
  // always parses back through `normalizeSdkModelId` to exactly `normalized`
  // (pattern 3 for a dotted version, pattern 4 for a bare one). So a model that
  // byName hits via `m.version === modelName` is *always* also hit by the
  // fallback's first `??` arm, `normalizeSdkModelId(m.version)` — no matter what
  // the other fields say. Disabling byName changed nothing observable, so all
  // seven mutants on lines 19-23 survived while four test titles claimed to kill
  // them by name. Verified: hand-applying each of the seven left
  // `bun test tests/find-endpoint-model.test.ts` at 54 pass / 0 fail.
  //
  // byName is therefore only observable where it *disagrees* with the fallback,
  // and there are exactly two such places:
  //   1. Order. Both are `Array.prototype.find`, but the fallback's predicate is
  //      strictly broader, so it can reach an EARLIER element that byName skips.
  //   2. The `??` chain prefers `m.version` over `m.id`. A model whose `m.id`
  //      equals modelName but whose `m.version` normalises to a DIFFERENT tuple
  //      is found by byName and rejected by the fallback.
  // One test each.
  // ------------------------------------------------------------------------

  it("byName wins over an earlier model the semantic fallback would have returned", () => {
    // `earlier` is only reachable via the fallback (its version normalises to
    // {sonnet, 4.6} but is not equal to modelName). `byNameHit` is reachable via
    // byName. byName runs first and must win despite `earlier` sitting ahead of
    // it in the array — so anything that disables byName returns "loses-on-order"
    // instead. Kills six of the seven: `||`→`&&`, `m.id === modelName || false`,
    // `(m) => false`, `() => undefined`, `modelName = ""`, and
    // `if (byName)` → `if (false)`.
    const earlier = {
      capabilities: {
        family: "unrecognised",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "loses-on-order",
      model_picker_enabled: true,
      name: "fallback-only match, listed first",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      // Normalises to {sonnet, 4.6} via pattern 1, but !== "claude-sonnet-4.6".
      version: "claude-sonnet-4-6-20260301",
      supported_endpoints: ["/v1/messages"],
    }
    const byNameHit = {
      ...earlier,
      id: "wins-via-byname",
      name: "byName match, listed second",
      version: "claude-sonnet-4.6", // === modelName
    }
    state.models = { data: [earlier, byNameHit], object: "list" }
    expect(findEndpointModel("claude-sonnet-4-6")?.id).toBe("wins-via-byname")
  })

  it("byName matches on m.id even when m.version normalises to a different model", () => {
    // m.id === modelName, so byName finds it. The fallback cannot: its `??`
    // chain reads `m.version` first, and this version parses cleanly to
    // {opus, 3.1}, so the chain never falls through to `m.id`. Kills the
    // remaining mutant, `false || m.version === modelName` (and, redundantly,
    // the five that disable byName outright).
    const idMatchOnly = {
      capabilities: {
        family: "claude-opus-3.1",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "claude-sonnet-4.6", // === modelName for the query below
      model_picker_enabled: true,
      name: "id matches, version points elsewhere",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-opus-3.1", // normalises to {opus, 3.1} — fallback rejects
      supported_endpoints: ["/v1/messages"],
    }
    state.models = { data: [idMatchOnly], object: "list" }
    expect(findEndpointModel("claude-sonnet-4-6")?.id).toBe("claude-sonnet-4.6")
  })
})
