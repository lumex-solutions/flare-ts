/**
 * Cloudflare in-process test harness helpers for export terminals and fake Durable Object state.
 * Re-exports fake env and storage factories; supplies a minimal ExecutionContext stub for `.export()` fetch.
 */

export { makeEnv, makeFakeDurableState, makeFakeStorage } from "../../../src/lib/host/runtime/cloudflare/testing.js";

/** Minimal `ExecutionContext` stub for the `.export()` fetch signature. */
export function makeExecutionContext(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>): void => {},
    passThroughOnException: (): void => {},
    props: {},
  } as unknown as ExecutionContext;
}
