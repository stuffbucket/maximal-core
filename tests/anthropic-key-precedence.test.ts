/**
 * Anthropic key precedence: env → file → config, the same order every other
 * knob follows (README → Configuration).
 *
 * `getAnthropicApiKey()` used to read the config file FIRST, so a
 * `config.anthropicApiKey` shadowed `ANTHROPIC_API_KEY` — and, because
 * `bootstrap.ts` materializes `secrets/anthropic` into that env var at boot, it
 * shadowed the secrets file too. It also disagreed with `secretStatus()`, which
 * reports `<env>` the moment the env var is set: `maximal debug` named a source
 * the resolver was not using.
 *
 * The two are asserted TOGETHER here on purpose. Either alone can be right while
 * the pair disagrees, and a diagnostic that disagrees with the resolver is worse
 * than no diagnostic — it sends you looking in the wrong file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AppConfig } from "~/lib/config/config"

import { secretStatus } from "~/debug"
import { SECRET_DEFS } from "~/lib/auth/secrets"
import { getAnthropicApiKey, getConfig, writeConfig } from "~/lib/config/config"

const originalEnv = process.env.ANTHROPIC_API_KEY
let originalConfig: AppConfig

function setEnvKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = value
  }
}

/** What `maximal debug` / `/_debug/state` would report for this secret. */
function reportedSource(config: AppConfig): string {
  const def = SECRET_DEFS.find((d) => d.name === "anthropic_api_key")
  expect(def).toBeDefined()
  return secretStatus(
    {
      name: def?.name ?? "",
      envVar: def?.envVar ?? "",
      configValue: def?.readConfig?.(config),
      // No fileName: this suite is about the env-vs-config ordering, and
      // peeking at the real secrets dir would make the result machine-dependent.
    },
    process.env,
  ).source
}

beforeEach(() => {
  originalConfig = getConfig()
})

afterEach(() => {
  setEnvKey(originalEnv)
  writeConfig(originalConfig)
})

describe("getAnthropicApiKey precedence", () => {
  test("env wins over the config file when both are set", () => {
    writeConfig({ ...originalConfig, anthropicApiKey: "from-config" })
    setEnvKey("from-env")

    expect(getAnthropicApiKey()).toBe("from-env")
  })

  test("the config file is used when the env var is unset", () => {
    writeConfig({ ...originalConfig, anthropicApiKey: "from-config" })
    setEnvKey(undefined)

    expect(getAnthropicApiKey()).toBe("from-config")
  })

  test("an empty env var falls through to the config file", () => {
    // `""` is how a spawn env clears a variable it must not inherit. It is not a
    // key, so it must not shadow a real one — and `secretStatus` already treats
    // it as absent.
    writeConfig({ ...originalConfig, anthropicApiKey: "from-config" })
    setEnvKey("")

    expect(getAnthropicApiKey()).toBe("from-config")
  })

  test("an empty config value is unset, not a key", () => {
    writeConfig({ ...originalConfig, anthropicApiKey: "" })
    setEnvKey(undefined)

    expect(getAnthropicApiKey()).toBeUndefined()
  })

  test("neither set resolves to undefined", () => {
    const { anthropicApiKey: _dropped, ...withoutKey } = originalConfig
    writeConfig(withoutKey)
    setEnvKey(undefined)

    expect(getAnthropicApiKey()).toBeUndefined()
  })
})

describe("the debug diagnostic agrees with the resolver", () => {
  test("reports env when the env var is what getAnthropicApiKey returns", () => {
    const config: AppConfig = {
      ...originalConfig,
      anthropicApiKey: "from-config",
    }
    writeConfig(config)
    setEnvKey("from-env")

    expect(reportedSource(config)).toBe("env")
    expect(getAnthropicApiKey()).toBe("from-env")
  })

  test("reports config when the config file is what it returns", () => {
    const config: AppConfig = {
      ...originalConfig,
      anthropicApiKey: "from-config",
    }
    writeConfig(config)
    setEnvKey(undefined)

    expect(reportedSource(config)).toBe("config")
    expect(getAnthropicApiKey()).toBe("from-config")
  })
})
