/**
 * Compile-time assertion helper.
 *
 * No runtime behaviour and no test runner: every assertion in this fixture is a
 * type error or it is nothing. `tsc` exiting non-zero is the failure signal.
 */

/**
 * Assert `value` is assignable to `Expected`.
 *
 * Assignability (not exactness) is the right check for a consumer surface: it
 * catches a removed or renamed field, a widened return type, and a changed
 * parameter shape, without failing on a purely additive change — which is what
 * a downstream consumer actually cares about.
 */
// The single use is the entire point: the caller supplies `Expected` explicitly
// and the parameter position is where the assignability check happens.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- explicit type argument is the assertion
export function expectAssignable<Expected>(_value: Expected): void {
  // Intentionally empty: the call site is the assertion.
}
