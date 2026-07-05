/**
 * Unit tests for ControllerBase response helpers and constructor wiring.
 */
import { describe, it, expect } from "vitest";
import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareHttpContext } from "../../../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { ResponseLike } from "../../../../../../../src/lib/arcs/http/transport/types/response.js";
import { ControllerBase } from "../../../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { FlareResponse } from "../../../../../../../src/lib/arcs/http/transport/flare-response.js";
import { Container } from "../../../../../../../src/lib/services/container.js";

/**
 * Test-only concrete subclass: ControllerBase is abstract and `#createResponse`
 * is private, but every public-facing helper (`ok`, `created`, ...) routes
 * through `#createResponse`. Exposing those helpers as public methods lets us
 * assert the response-shape behaviour for both branches (`null`, string, JSON).
 */
class TestController extends ControllerBase {
  public callOk(body: JsonValue): ResponseLike {
    return this.ok(body);
  }
  public callCreated(body: JsonValue): ResponseLike {
    return this.created(body);
  }
  public callNoContent(): ResponseLike {
    return this.noContent();
  }
  public callRedirect(location: string, options?: { permanent?: boolean; preserveMethod?: boolean; }): ResponseLike {
    return this.redirect(location, options);
  }
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
 * Build a controller wired to a real Container and a minimal FlareHttpContext
 * stand-in. None of the helpers under test touch the container or the context,
 * so a bare Container and an empty object cast as FlareHttpContext exercise
 * the exact code path used in production without pulling in transport setup.
 */
function makeController(): TestController {
  const container = new Container({ get: () => undefined }, new Map(), {});
  const ctx = {} as FlareHttpContext;
  return new TestController(container, ctx);
}

describe("response body shaping by content type", () => {
  it("Body null: returns FlareResponse(status) with no body", () => {
    const ctrl = makeController();
    const res = ctrl.callNoContent();
    expect(res).toBeInstanceOf(FlareResponse);
    const r = res as FlareResponse;
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
    expect(r.jsonBody).toBeNull();
    // No headers are attached for a null-body response.
    expect(r.headers).toEqual({});
  });

  it("Body string: returns FlareResponse(status, body) (text branch)", () => {
    const ctrl = makeController();
    const res = ctrl.callOk("hello");
    expect(res).toBeInstanceOf(FlareResponse);
    const r = res as FlareResponse;
    expect(r.status).toBe(200);
    // String bodies are stored verbatim on `body` (not `jsonBody`).
    expect(r.body).toBe("hello");
    expect(r.jsonBody).toBeNull();
    // The string branch sets a text/plain Content-Type and Content-Length.
    expect(r.headers["Content-Type"]).toBe("text/plain");
    expect(r.headers["Content-Length"]).toBe("5");
  });

  it("Body JsonValue object: returns FlareResponse(status, body) (json branch)", () => {
    const ctrl = makeController();
    const payload = { id: 1, name: "ok" };
    const res = ctrl.callOk(payload);
    expect(res).toBeInstanceOf(FlareResponse);
    const r = res as FlareResponse;
    expect(r.status).toBe(200);
    // JSON bodies stay on `jsonBody` until the per-status serializer runs.
    expect(r.body).toBeNull();
    expect(r.jsonBody).toBe(payload);
    expect(r.headers["Content-Type"]).toBe("application/json");
    // Content-Length is pre-allocated as an empty string for V8 hidden-class stability.
    expect(r.headers["Content-Length"]).toBe("");
  });

  it("Numeric and boolean JsonValue use the JSON branch, not the string branch", () => {
    const ctrl = makeController();

    const num = ctrl.callOk(42) as FlareResponse;
    expect(num.body).toBeNull();
    expect(num.jsonBody).toBe(42);
    expect(num.headers["Content-Type"]).toBe("application/json");

    const bool = ctrl.callOk(true) as FlareResponse;
    expect(bool.body).toBeNull();
    expect(bool.jsonBody).toBe(true);
    expect(bool.headers["Content-Type"]).toBe("application/json");
  });

  it("noContent() has no JSON Content-Type; redirect() has Location only", () => {
    const ctrl = makeController();

    const empty = ctrl.callNoContent() as FlareResponse;
    expect(empty.headers["Content-Type"]).toBeUndefined();
    expect(empty.headers["Location"]).toBeUndefined();

    const moved = ctrl.callRedirect("/next") as FlareResponse;
    expect(moved.headers["Location"]).toBe("/next");
    expect(moved.headers["Content-Type"]).toBeUndefined();
  });
});

describe("ControllerBase response helpers", () => {
  it("returns 200 with the given JSON body for the ok helper", () => {
    const ctrl = makeController();
    const res = ctrl.callOk({ ok: true }) as FlareResponse;
    expect(res).toBeInstanceOf(FlareResponse);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true });
  });

  it("returns 201 with the given JSON body for the created helper", () => {
    const ctrl = makeController();
    const res = ctrl.callCreated({ id: 42 }) as FlareResponse;
    expect(res).toBeInstanceOf(FlareResponse);
    expect(res.status).toBe(201);
    expect(res.jsonBody).toEqual({ id: 42 });
  });

  it("returns 204 with a null body for the noContent helper", () => {
    const ctrl = makeController();
    const res = ctrl.callNoContent() as FlareResponse;
    expect(res).toBeInstanceOf(FlareResponse);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(res.jsonBody).toBeNull();
  });

  it("returns 302 with a Location header for the default redirect helper", () => {
    const ctrl = makeController();
    const res = ctrl.callRedirect("/next") as FlareResponse;
    expect(res).toBeInstanceOf(FlareResponse);
    expect(res.status).toBe(302);
    expect(res.headers["Location"]).toBe("/next");
    // The body of every redirect is null (helper passes `null` to the constructor).
    expect(res.body).toBeNull();
    expect(res.jsonBody).toBeNull();
  });

  it("returns the correct redirect status for permanent and preserveMethod options", () => {
    const ctrl = makeController();

    const permanent = ctrl.callRedirect("/p", { permanent: true }) as FlareResponse;
    expect(permanent.status).toBe(301);
    expect(permanent.headers["Location"]).toBe("/p");

    const permanentPreserve = ctrl.callRedirect("/pp", {
      permanent: true,
      preserveMethod: true,
    }) as FlareResponse;
    expect(permanentPreserve.status).toBe(308);
    expect(permanentPreserve.headers["Location"]).toBe("/pp");

    const preserve = ctrl.callRedirect("/m", { preserveMethod: true }) as FlareResponse;
    expect(preserve.status).toBe(307);
    expect(preserve.headers["Location"]).toBe("/m");
  });

  it("returns the expected error status codes for each error response helper", () => {
    const ctrl = makeController();

    const cases: Array<[() => ResponseLike, number]> = [
      [() => ctrl.callBadRequest({ msg: "bad" }), 400],
      [() => ctrl.callUnauthorized({ msg: "auth" }), 401],
      [() => ctrl.callForbidden({ msg: "no" }), 403],
      [() => ctrl.callNotFound({ msg: "missing" }), 404],
      [() => ctrl.callTooManyRequests({ msg: "slow" }), 429],
      [() => ctrl.callError({ msg: "boom" }), 500],
    ];

    for (const [invoke, expectedStatus] of cases) {
      const res = invoke() as FlareResponse;
      expect(res).toBeInstanceOf(FlareResponse);
      expect(res.status).toBe(expectedStatus);
      // Each helper passes a JsonValue object; the JSON branch is taken.
      expect(res.headers["Content-Type"]).toBe("application/json");
    }
  });
});
