// Real-binding smoke for the GENERATED Durable Object class. Driving it through a wrangler DO binding
// (the `tests/cloudflare/fixtures/durable-worker.ts` `main`) is the only way to exercise the native
// `super(ctx, env)` ctor + `init` (inside `blockConcurrencyWhile`) — workerd's DurableObject base
// rejects a fake ctx, so the in-process suite (composeDurableInstance) cannot reach this glue.
//
// NOTE: storage-mutating / alarm / WebSocket assertions belong alongside this but are deferred to CI
// (Linux). On the pinned @cloudflare/vitest-pool-workers 0.12.x line, automatic per-test isolated
// storage unlinks the DO SQLite between tests, which hits a confirmed, unfixed miniflare-on-Windows
// file-lock bug (cloudflare/workers-sdk #10511) — `isolatedStorage:false` breaks DO storage outright
// here. The reset-without-unlink helpers (`abortAllDurableObjects`) that would sidestep it only exist
// on pool >= 0.13, which requires vitest 4 (this repo is on vitest 2). The fixture wires
// init/alarm(info)/webSocketMessage so CI exercises them; this smoke is read-only, so it runs everywhere.
import { env } from "cloudflare:test";
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
