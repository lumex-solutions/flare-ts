/**
 * Test harness for driving the terminal export shapes directly:
 *  - `.export()` -> `handle.fetch(request, makeEnv(...), makeExecutionContext())`
 *  - The Durable Object base is `FlareDurableObject`, registered via `host.durableObject(Class)`.
 *    There is no `.durableObject()` terminal. In-process, drive the per-instance graph with
 *    `composeDurableInstance(host, makeFakeDurableState(...), makeEnv(...))` then `inst.fetch(req)` or
 *    `inst.inject(deps, token)`. The real class (constructor, alarm, WebSocket, RPC) is exercised via a
 *    wrangler binding, since workerd's DurableObject base rejects a fake ctx.
 */

export { makeFakeStorage, makeFakeDurableState, makeEnv } from "../../../src/lib/host/runtime/cloudflare/testing.js";

/** Minimal `ExecutionContext` stub for the `.export()` fetch signature. */
export function makeExecutionContext(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>): void => {},
    passThroughOnException: (): void => {},
    props: {},
  } as unknown as ExecutionContext;
}
