// Fixture worker for real-binding Durable Object tests (the wrangler `main`). Builds a Flare app and
// exports a Durable Object via the `.durableObject()` terminal, so tests can drive the GENERATED DO
// class through a real binding (workerd's native DurableObject base rejects a fake ctx, so this is
// the only way to exercise the ctor / init-in-blockConcurrencyWhile / alarm(info) / WebSocket wiring).
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareHost, FlareResponse, FlareService } from "../../../src/index.js";
import { Bindings, buildCf, DurableState } from "../../../src/lib/host/runtime/cloudflare/index.js";

const flareJson = { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };

/** Per-instance counter, hydrated from durable storage by `init`. */
class Counter extends FlareService {
  static override deps = [DurableState] as const;
  #n = 0;
  get n(): number {
    return this.#n;
  }
  hydrate(value: number): void {
    this.#n = value;
  }
  async bump(): Promise<number> {
    this.#n++;
    await this.inject(DurableState).storage.put("n", this.#n);
    return this.#n;
  }
}

const host = new FlareHost(buildCf(flareJson));
host.singleton(Counter);

host.http.get(
  "/n",
  { inject: { counter: Counter, ds: DurableState, bindings: Bindings } },
  (_c, s) =>
    new FlareResponse(200, {
      n: s.counter.n,
      id: s.ds.id.toString(),
      flag: s.bindings.env.FLAG ?? null,
    }),
);
host.http.post(
  "/bump",
  { inject: { counter: Counter } },
  async (_c, s) => new FlareResponse(200, { n: await s.counter.bump() }),
);

/** The Durable Object class under test — exported as the `TEST_ROOM` binding's `class_name`. */
export const TestRoom = (host.build() as CloudflareApp).durableObject({
  init: {
    inject: { ds: DurableState, counter: Counter },
    handler: async (scope) => {
      const stored = await scope.ds.storage.get<number>("n");
      if (stored !== undefined) scope.counter.hydrate(stored);
    },
  },
  alarm: {
    inject: { ds: DurableState },
    handler: async (scope, info) => {
      // Record what workerd handed the entrypoint so a test can assert the AlarmInvocationInfo threading.
      await scope.ds.storage.put("alarmInfo", {
        isRetry: info?.isRetry ?? null,
        retryCount: info?.retryCount ?? null,
      });
    },
  },
  webSocketMessage: (_scope, ws, message) => {
    ws.send(`echo:${typeof message === "string" ? message : "binary"}`);
  },
});

export default {
  fetch(): Response {
    return new Response("control-plane");
  },
};
