import type { RequestAdapter } from "../arcs/http/transport/types/adapter.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceToken } from "../services/types/types.js";
import type { MockContextOpts } from "./types/mock-context-opts.js";
import { FlareHttpContext } from "../arcs/http/transport/flare-http-context.js";
import { FlareRequest, SET_RAW_BODY, SET_ROUTE_PARAMS } from "../arcs/http/transport/flare-request.js";
import { Container } from "../services/container.js";
import { FlareRegistrationMap } from "../services/registration-map.js";
import { FlareTestError } from "./error.js";

interface MockNativeRequest {
  headers: Headers;
}

/**
 * Minimal DI container surface returned by {@link mockContainer}.
 *
 * Wraps the same internal {@link Container} class the runtime uses for request
 * scopes. Exposed under this alias so tests can annotate mocks without importing
 * framework internals from deep paths.
 */
export type MockContainer = Container;

const MOCK_ADAPTER: RequestAdapter = {
  rawHeaders(req: unknown): Headers {
    return (req as MockNativeRequest).headers;
  },
  signal(): AbortSignal {
    return new AbortController().signal;
  },
  background(fn: () => Promise<unknown>): void {
    fn();
  },
};

/**
 * Constructs a {@link FlareHttpContext} with a synthetic {@link FlareRequest} and a
 * zero-allocation mock adapter. Use for unit-testing controllers, middleware, and
 * handler functions without the integration pipeline.
 *
 * Body is raw bytes only; no auto-JSON. The integration harness
 * ({@link FlareTestApp.fetch}) auto-serializes, but the unit surface intentionally
 * does not, so the bytes you pass are exactly what the handler will see.
 *
 * State tokens and route params are provided as `Map` instances because their keys
 * (state token objects, route param strings) cannot be used as computed object
 * literal keys reliably.
 */
export function mockContext(opts: MockContextOpts = {}): FlareHttpContext {
  const method = opts.method ?? "GET";
  const url = opts.url ?? "/";

  const headers = new Headers();
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers.set(k, v);
  }
  const native: MockNativeRequest = { headers };

  const req = new FlareRequest(
    MOCK_ADAPTER,
    method,
    url,
    opts.requestId ?? "mock-req",
    native,
  );

  if (opts.body !== undefined && opts.body !== null) {
    const buf: ArrayBuffer = opts.body instanceof Uint8Array
      ? (opts.body.buffer as ArrayBuffer).slice(
        opts.body.byteOffset,
        opts.body.byteOffset + opts.body.byteLength,
      )
      : opts.body;
    req[SET_RAW_BODY](buf);
  } else if (opts.body === null) {
    req[SET_RAW_BODY](null);
  }

  if (opts.params) {
    const routeParams: Record<string, string> = {};
    for (const [k, v] of opts.params) routeParams[k] = v;
    req[SET_ROUTE_PARAMS](routeParams);
  }

  const ctx = new FlareHttpContext(req);

  if (opts.state) {
    let i = 0;
    for (const [token, value] of opts.state) {
      if (
        typeof token !== "object"
        || token === null
        || typeof (token as { name?: unknown; }).name !== "string"
      ) {
        throw new FlareTestError(
          `mockContext received an invalid state key at index ${i}: expected a StateToken, got ${
            token === null ? "null" : typeof token
          }`,
        );
      }
      // Cast through unknown: StateToken's value type is opaque here; the developer
      // is responsible for matching the token's declared type at the test call site.
      ctx.state.set(token as unknown as never, value as never);
      i++;
    }
  }

  return ctx;
}

/**
 * Constructs a minimal {@link Container} that resolves tokens from a developer-
 * provided map. Use for unit-testing controllers or services that take a
 * `Container` in their constructor.
 *
 * The fakes in the map are placed directly into the container's singletons map,
 * so `resolveDep` returns them immediately on the fast path. Missing deps surface
 * at `resolveDep` time (via the standard `"ServiceToken X not registered in
 * container"` error): loud and accurate, scoped to whichever token the test
 * code actually tries to resolve.
 */
export function mockContainer(
  services: ReadonlyMap<ServiceToken<FlareService>, FlareService>,
): MockContainer {
  return new Container(new FlareRegistrationMap(), services, {});
}
