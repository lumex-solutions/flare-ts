/**
 * Test harness for driving the terminal export shapes directly:
 *  - `.export()` → `handle.fetch(request, makeEnv(...), makeExecutionContext())`
 *  - The Durable Object base is `FlareDurableObject`, registered via `host.durableObject(Class)`.
 *    There is no `.durableObject()` terminal. In-process, drive the per-instance graph with
 *    `composeDurableInstance(host, makeFakeDurableState(...), makeEnv(...))` then `inst.fetch(req)` or
 *    `inst.inject(deps, token)`. The real class (constructor, alarm, WebSocket, RPC) is exercised via a
 *    wrangler binding, since workerd's DurableObject base rejects a fake ctx.
 */

/** Wraps a plain bindings object as `Cloudflare.Env` for a terminal's `env`. */
export function makeEnv<T extends Record<string, unknown>>(bindings: T = {} as T): Cloudflare.Env {
  return bindings as unknown as Cloudflare.Env;
}

/** Minimal `ExecutionContext` stub for the `.export()` fetch signature. */
export function makeExecutionContext(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>): void => {},
    passThroughOnException: (): void => {},
    props: {},
  } as unknown as ExecutionContext;
}

/** Minimal in-memory `DurableObjectStorage` (KV subset). Pass your own for SQL-backed tests. */
export function makeFakeStorage(): DurableObjectStorage {
  const kv = new Map<string, unknown>();
  return {
    get: async (key: string): Promise<unknown> => kv.get(key),
    put: async (key: string, value: unknown): Promise<void> => {
      kv.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => kv.delete(key),
    list: async (): Promise<Map<string, unknown>> => new Map(kv),
  } as unknown as DurableObjectStorage;
}

/**
 * Builds a fake `DurableObjectState` for unit-testing Flare's per-instance DI without a DO binding.
 * Distinct `name`s yield distinct `id`s — use that to assert per-instance isolation across two DOs.
 */
export function makeFakeDurableState(
  opts: { name?: string; storage?: DurableObjectStorage; } = {},
): DurableObjectState {
  const name = opts.name ?? "test-do";
  const id = {
    toString: (): string => name,
    equals: (other: DurableObjectId): boolean => other?.toString() === name,
    name,
  } as unknown as DurableObjectId;
  const storage = opts.storage ?? makeFakeStorage();
  return {
    id,
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    waitUntil: (_p: Promise<unknown>): void => {},
    abort: (_reason?: string): void => {},
  } as unknown as DurableObjectState;
}
