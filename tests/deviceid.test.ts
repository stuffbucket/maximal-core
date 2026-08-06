import { afterAll, expect, mock, test } from "bun:test"

import { getVSCodeDeviceId } from "../src/lib/auth/deviceid"

// Capture the real module so afterAll can restore it via an AWAITED
// mock.module — `mock.restore()` does NOT undo `mock.module` in Bun, so
// without this the winreg stub would leak forward into other test files.
//
// The capture is a spread COPY, not the namespace: `mock.module` mutates the
// live module record in place, so the namespace object would already hold
// `FailingWinreg` by the time afterAll reads it and the restore would re-install
// the stub. See docs/dev/testing-strategy.md §5.1.
const realWinreg = { ...(await import("winreg")) }

const failingRegistryError = new Error("registry unavailable")

class FailingWinreg {
  static HKCU = "HKCU"
  static REG_SZ = "REG_SZ"

  get(
    _name: string,
    callback: (error: Error | null, item: { value?: string } | null) => void,
  ) {
    callback(failingRegistryError, null)
  }

  set(
    ...args: [
      name: string,
      type: string,
      value: string,
      callback: (error: Error | null) => void,
    ]
  ) {
    const callback = args[3]
    callback(failingRegistryError)
  }
}

afterAll(async () => {
  await mock.module("winreg", () => realWinreg)
})

test("getVSCodeDeviceId falls back to an ephemeral UUID when persistence fails", async () => {
  await mock.module("winreg", () => ({
    default: FailingWinreg,
  }))

  const deviceId = await getVSCodeDeviceId()

  expect(deviceId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})
