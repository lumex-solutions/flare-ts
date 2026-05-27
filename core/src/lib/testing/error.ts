/**
 * Thrown by the in-process test harness when the harness itself rejects an
 * invalid input or detects misuse. Distinct from `FlareError` (the app's HTTP
 * error contract) and from runtime errors: assert `instanceof FlareTestError`
 * to confirm a failure originated in the harness, not the app under test.
 */
export class FlareTestError extends Error {
  override readonly name = "FlareTestError";
}
