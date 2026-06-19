// Real-binding smoke for the GENERATED Durable Object class. Driving it through a wrangler DO binding
// (the `tests/cloudflare/fixtures/durable-worker.ts` `main`) is the only way to exercise the native
// `super(ctx, env)` ctor + `init` (inside `blockConcurrencyWhile`) — workerd's DurableObject base
// rejects a fake ctx, so the in-process suite (composeDurableInstance) cannot reach this glue.
//
// This file is the read-only smoke (init ran, ids/bindings resolve). Storage-mutating, reset, and
// alarm assertions live in `do-storage.test.ts`
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Flare Durable Object via a real binding", () => {
  it("instantiates the generated DO class and routes a fetch — init runs, DurableState.id + Bindings.env resolve", async () => {
    const id = env.TEST_ROOM.idFromName("alpha");
    const res = await env.TEST_ROOM.get(id).fetch(new Request("https://do/n"));

    expect(res.status).toBe(200);
    // n:0 → init ran (hydrate found nothing); id → the real ctx's DurableObjectState; flag → the env binding.
    expect(await res.json()).toEqual({ n: 0, id: id.toString(), flag: "on" });
  });
});
