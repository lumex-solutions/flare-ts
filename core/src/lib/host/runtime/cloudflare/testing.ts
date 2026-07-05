/**
 * White-box testing primitives for Flare's Cloudflare Durable Object runtime.
 *
 * Use these helpers together with `composeDurableInstance` to drive the real
 * per-instance container graph in-process without a miniflare/workerd binding.
 *
 * @example
 * ```ts
 * import { composeDurableInstance, makeFakeDurableState, makeFakeStorage, makeEnv } from "@flare-ts/core/cloudflare";
 *
 * const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-1" }), makeEnv(), MyDO);
 * const res = await inst.fetch(new Request("https://do/route"));
 * ```
 *
 * Cast note: each fake implements only the slice the runtime consumes and is widened to the full
 * Cloudflare nominal type, so tests compose it wherever the real binding goes. A fake reaching an
 * unimplemented member fails loudly at the call site.
 */

/**
 * Wraps a plain bindings object as `Cloudflare.Env` for passing to
 * `composeDurableInstance` or a terminal's `fetch(req, env, ctx)` signature.
 *
 * @param bindings - Key/value bindings to expose as the environment.
 */
export function makeEnv<T extends Record<string, unknown>>(bindings: T = {} as T): Cloudflare.Env {
  return bindings as unknown as Cloudflare.Env;
}

/**
 * Minimal in-memory `DurableObjectStorage` stub covering the KV subset of the
 * interface: `get`, `put`, `delete`, and `list`.
 *
 * **No SQL support.** This stub does NOT implement `sql` or any SQLite-backed
 * methods. DOs that rely on `state.storage.sql` must use a real `cloudflare:test`
 * binding (see `do-storage.test.ts` for the real-binding tier).
 */
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
 * Builds a fake `DurableObjectState` for unit-testing Flare's per-instance DI
 * without a real DO binding.
 *
 * Each distinct `name` yields a distinct `DurableObjectId`. Pass two instances
 * with different names to assert per-instance isolation across two DOs.
 *
 * @param opts.name    - Logical name for this fake DO instance. Defaults to `"test-do"`.
 * @param opts.storage - Custom storage stub. Defaults to `makeFakeStorage()`.
 *
 * @example
 * ```ts
 * const stateA = makeFakeDurableState({ name: "room-alpha" });
 * const stateB = makeFakeDurableState({ name: "room-beta" });
 * const instA = composeDurableInstance(host, stateA, makeEnv(), MyDO);
 * const instB = composeDurableInstance(host, stateB, makeEnv(), MyDO);
 * // instA and instB have separate, isolated container graphs.
 * ```
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
