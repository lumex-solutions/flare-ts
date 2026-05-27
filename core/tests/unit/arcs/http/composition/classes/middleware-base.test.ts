import { describe, it, expect } from "vitest";
import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareHttpContext } from "../../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { ResponseLike } from "../../../../../../src/lib/arcs/http/transport/types/response.js";
import { MiddlewareBase } from "../../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { FlareResponse } from "../../../../../../src/lib/arcs/http/transport/flare-response.js";
import { Container } from "../../../../../../src/lib/services/container.js";

/**
 * Test-only concrete subclass exposing protected response helpers as public
 * methods so the JSON-branch behaviour of `#createResponse` is observable.
 */
class TestMiddleware extends MiddlewareBase {
  public callBadRequest(body: JsonValue): ResponseLike {
    return this.badRequest(body);
  }
  public callUnauthorized(body: JsonValue): ResponseLike {
    return this.unauthorized(body);
  }
  public callForbidden(body: JsonValue): ResponseLike {
    return this.forbidden(body);
  }
  public callNotFound(body: JsonValue): ResponseLike {
    return this.notFound(body);
  }
  public callTooManyRequests(body: JsonValue): ResponseLike {
    return this.tooManyRequests(body);
  }
  public callError(body: JsonValue): ResponseLike {
    return this.error(body);
  }
}

/**
 * Middleware constructor takes a Container and a FlareHttpContext. Neither is
 * touched by the response helpers, so a bare Container plus an empty-object
 * stand-in for the context is the smallest faithful stub.
 */
function makeMiddleware(): TestMiddleware {
  const container = new Container({ get: () => undefined }, new Map(), {});
  const ctx = {} as FlareHttpContext;
  return new TestMiddleware(container, ctx);
}

describe("MiddlewareBase response helpers", () => {
  it("badRequest -> 400; unauthorized -> 401; forbidden -> 403; notFound -> 404; tooManyRequests -> 429; error -> 500", () => {
    const mw = makeMiddleware();

    const cases: Array<[() => ResponseLike, number]> = [
      [() => mw.callBadRequest({ msg: "bad" }), 400],
      [() => mw.callUnauthorized({ msg: "auth" }), 401],
      [() => mw.callForbidden({ msg: "no" }), 403],
      [() => mw.callNotFound({ msg: "missing" }), 404],
      [() => mw.callTooManyRequests({ msg: "slow" }), 429],
      [() => mw.callError({ msg: "boom" }), 500],
    ];

    for (const [invoke, expectedStatus] of cases) {
      const res = invoke() as FlareResponse;
      expect(res).toBeInstanceOf(FlareResponse);
      expect(res.status).toBe(expectedStatus);
      // `#createResponse` always takes the JSON branch in MiddlewareBase
      // (signature is `JsonValue`, not `JsonValue | null` or string), so every
      // helper sets Content-Type: application/json and pre-allocates Content-Length.
      expect(res.headers["Content-Type"]).toBe("application/json");
      expect(res.headers["Content-Length"]).toBe("");
      // JSON bodies stay on `jsonBody` until the per-status serializer runs.
      expect(res.body).toBeNull();
    }
  });

  it("before/after/finally are optional and absent by default", () => {
    const mw = makeMiddleware();
    // The three hooks are declared with `?` and are not defined by the base
    // class. A bare subclass therefore exposes them as `undefined`, so the
    // dispatcher can `if (mw.before)` to skip them without instantiating
    // empty closures.
    expect(mw.before).toBeUndefined();
    expect(mw.after).toBeUndefined();
    expect(mw.finally).toBeUndefined();
  });
});
