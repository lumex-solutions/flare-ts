/**
 * `@flare-ts/core/cloudflare/testing` -- public white-box testing surface for
 * Flare Cloudflare Durable Objects.
 *
 * Re-exports the in-process DO composition primitive and KV-only fake state
 * helpers. Use these to drive the real per-instance container graph without
 * miniflare or workerd.
 *
 * @example
 * ```ts
 * import { composeDurableInstance } from "@flare-ts/core/cloudflare/testing";
 * import { makeFakeDurableState, makeFakeStorage, makeEnv } from "@flare-ts/core/cloudflare/testing";
 *
 * const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-1" }), makeEnv(), MyDO);
 * const res = await inst.fetch(new Request("https://do/route"));
 * inst.inject([MyService], MyService); // resolve from the per-instance container
 * ```
 */

export { composeDurableInstance } from "../lib/host/runtime/cloudflare/durable-object.js";
export { makeFakeStorage, makeFakeDurableState, makeEnv } from "../lib/host/runtime/cloudflare/testing.js";
