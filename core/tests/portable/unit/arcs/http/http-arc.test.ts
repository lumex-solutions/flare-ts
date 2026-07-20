/**
 * Unit tests for `HttpArc` lifecycle symbols, `group()`, compile, and `fetch()` routing
 * (405, path guards, OPTIONS). Deeper pipeline branches are covered by integration tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { ControllerClass } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { RequestAdapter } from "../../../../../src/lib/arcs/http/transport/types/adapter.js";
import type { IFlareHost } from "../../../../../src/lib/host/flare-host.js";
import { ControllerBase } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { HttpGroup } from "../../../../../src/lib/arcs/http/composition/group.js";
import { clearExecShapeCache } from "../../../../../src/lib/arcs/http/exec-codegen.js";
import {
  COMPILE_HTTP_ARC,
  HttpArc,
  INSPECT_HTTP_ARC,
  START_HTTP_ARC,
  START_HTTP_ARC_ASYNC,
  STOP_HTTP_ARC,
  STOP_HTTP_ARC_ASYNC,
} from "../../../../../src/lib/arcs/http/http-arc.js";
import { INVALID_REQUEST_PATH_MESSAGE } from "../../../../../src/lib/arcs/http/routing/path.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../src/lib/arcs/http/routing/route-store.js";
import { FlareHttpContext } from "../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";

function attachRoutes(
  cls: ControllerClass,
  routes: Array<{ method: string; path: string; handler: (...args: unknown[]) => unknown; }>,
): void {
  const meta = {} as DecoratorMetadataObject;
  (cls as unknown as Record<symbol, DecoratorMetadataObject>)[DECORATOR_METADATA_SYMBOL] = meta;
  ROUTE_STORE.set(
    meta,
    routes.map((r) => ({
      method: r.method,
      path: r.path,
      handler: r.handler as never,
    })),
  );
}

function makeControllerCls(name: string): ControllerClass {
  class C extends ControllerBase {
    static override deps = [];
    static override state = [];
  }
  Object.defineProperty(C, "name", { value: name });
  return C as unknown as ControllerClass;
}

function makeFakeHost(opts: { scopedCount?: number; } = {}): IFlareHost {
  const scopedCount = opts.scopedCount ?? 0;
  // A minimal IFlareHost skeleton: only the fields that http-arc.ts touches.
  return {
    scopedServices: { get: () => undefined, tokens: () => [].values(), length: scopedCount } as never,
    singletonServices: new Map(),
    config: { host: { maxBodyBytes: 1024 * 1024 } },
    logger: {
      warn() {},
      error() {},
      info() {},
      debug() {},
      trace() {},
      fatal() {},
    } as never,
  } as unknown as IFlareHost;
}

const requestAdapter: RequestAdapter = {
  rawHeaders: () => new Headers(),
  signal: () => new AbortController().signal,
  background: () => {},
};

function makeCtx(method: string, url: string): FlareHttpContext {
  const req = new FlareRequest(requestAdapter, method, url, "req-1", null);
  return new FlareHttpContext(req);
}

beforeEach(() => {
  clearExecShapeCache();
});

describe("HttpArc lifecycle: onStart / onStop append in registration order", () => {
  it("registers onStart callbacks in registration order", () => {
    const arc = new HttpArc(makeFakeHost());
    const calls: number[] = [];
    arc.onStart(() => {
      calls.push(1);
    });
    arc.onStart(() => {
      calls.push(2);
    });

    arc[START_HTTP_ARC]();
    expect(calls).toEqual([1, 2]);
  });

  it("registers onStop callbacks in registration order", () => {
    const arc = new HttpArc(makeFakeHost());
    const calls: number[] = [];
    arc.onStop(() => {
      calls.push(1);
    });
    arc.onStop(() => {
      calls.push(2);
    });

    arc[STOP_HTTP_ARC]();
    expect(calls).toEqual([1, 2]);
  });
});

describe("[START_HTTP_ARC]", () => {
  it("throws when an onStart callback returns a Promise", () => {
    const arc = new HttpArc(makeFakeHost());
    arc.onStart(() => Promise.resolve() as never);

    expect(() => arc[START_HTTP_ARC]()).toThrow(
      "[flare] Sync runtime lifecycle callback returned a Promise.",
    );
  });
});

describe("[START_HTTP_ARC_ASYNC]", () => {
  it("awaits each callback in registration order", async () => {
    const arc = new HttpArc(makeFakeHost());
    const calls: number[] = [];
    arc.onStart(async () => {
      await Promise.resolve();
      calls.push(1);
    });
    arc.onStart(async () => {
      await Promise.resolve();
      calls.push(2);
    });

    await arc[START_HTTP_ARC_ASYNC]();
    expect(calls).toEqual([1, 2]);
  });
});

describe("[STOP_HTTP_ARC]", () => {
  it("throws when an onStop callback returns a Promise", () => {
    const arc = new HttpArc(makeFakeHost());
    arc.onStop(() => Promise.resolve() as never);

    expect(() => arc[STOP_HTTP_ARC]()).toThrow(
      "[flare] Sync runtime lifecycle callback returned a Promise.",
    );
  });
});

describe("[STOP_HTTP_ARC_ASYNC]", () => {
  it("awaits each callback in registration order", async () => {
    const arc = new HttpArc(makeFakeHost());
    const calls: string[] = [];
    arc.onStop(async () => {
      await Promise.resolve();
      calls.push("a");
    });
    arc.onStop(async () => {
      await Promise.resolve();
      calls.push("b");
    });

    await arc[STOP_HTTP_ARC_ASYNC]();
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("group(prefix, builder)", () => {
  it("invokes builder with a fresh HttpGroup and pushes the returned GroupRegistration", () => {
    const arc = new HttpArc(makeFakeHost());
    let received: HttpGroup | undefined;

    arc.group("/v1", (g) => {
      received = g;
      return g.register();
    });

    expect(received).toBeInstanceOf(HttpGroup);
    expect(received!.prefix).toBe("/v1");
    expect(arc.groups).toHaveLength(1);
    expect(arc.groups[0]!.prefix).toBe("/v1");
  });
});

describe("[COMPILE_HTTP_ARC]", () => {
  it("delegates to compileHttp using controllers + group controllers and exposes a router on completion", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("CompileMe");
    const handlerResp = new FlareResponse(200, { compiled: true });
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/c",
        handler: function() {
          return handlerResp;
        },
      },
    ]);
    arc.controller("/", cls);

    const groupCls = makeControllerCls("GroupCompileMe");
    const groupHandlerResp = new FlareResponse(200, { groupCompiled: true });
    attachRoutes(groupCls, [
      {
        method: "GET",
        path: "",
        handler: function() {
          return groupHandlerResp;
        },
      },
    ]);
    arc.group("/api", (g) => {
      g.controller("/g", groupCls);
      return g.register();
    });

    arc[COMPILE_HTTP_ARC]();

    // Compiled state is private; observe it via fetch returning a non-503 response.
    const topRes = arc.fetch(makeCtx("GET", "/c"));
    expect(topRes).not.toBeInstanceOf(Promise);
    expect((topRes as FlareResponse).status).toBe(200);

    const groupRes = arc.fetch(makeCtx("GET", "/api/g"));
    expect(groupRes).not.toBeInstanceOf(Promise);
    expect((groupRes as FlareResponse).status).toBe(200);
  });

  it("usesSharedContainer is true when no scoped services are registered", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("SharedCtl");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/s",
        handler: function() {
          return new FlareResponse(200, { ok: true });
        },
      },
    ]);
    arc.controller("/", cls);

    arc[COMPILE_HTTP_ARC]();

    expect(arc[INSPECT_HTTP_ARC]().usesSharedContainer).toBe(true);
  });

  it("usesSharedContainer is false when scoped services exist", () => {
    const arc = new HttpArc(makeFakeHost({ scopedCount: 1 }));
    const cls = makeControllerCls("ScopedCtl");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/s",
        handler: function() {
          return new FlareResponse(200, { ok: true });
        },
      },
    ]);
    arc.controller("/", cls);

    arc[COMPILE_HTTP_ARC]();

    expect(arc[INSPECT_HTTP_ARC]().usesSharedContainer).toBe(false);
  });
});

describe("HttpArc.fetch", () => {
  it("returns 503 when fetch is called before compile", () => {
    const arc = new HttpArc(makeFakeHost());
    const res = arc.fetch(makeCtx("GET", "/anything"));

    expect(res).toBeInstanceOf(FlareResponse);
    expect((res as FlareResponse).status).toBe(503);
  });

  it("returns 404 'Not Found' when no route matches", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("OneRoute");
    attachRoutes(cls, [{ method: "GET", path: "/registered", handler: function() {} }]);
    arc.controller("/", cls);
    arc[COMPILE_HTTP_ARC]();

    const res = arc.fetch(makeCtx("GET", "/nope"));
    expect(res).toBeInstanceOf(FlareResponse);
    expect((res as FlareResponse).status).toBe(404);
    expect((res as FlareResponse).body).toBe("Not Found");
  });

  it("returns 405 with an Allow header that lists the supported methods (and HEAD when GET is present)", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("GetOnly");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/r",
        handler: function() {
          return new FlareResponse(200);
        },
      },
    ]);
    arc.controller("/", cls);
    arc[COMPILE_HTTP_ARC]();

    // PUT is not registered. Expect 405 + Allow: "GET, HEAD".
    const res = arc.fetch(makeCtx("PUT", "/r"));
    expect(res).toBeInstanceOf(FlareResponse);
    const r = res as FlareResponse;
    expect(r.status).toBe(405);
    expect((r.headers as Record<string, string>).Allow).toBe("GET, HEAD");
  });

  it("returns 405 with Allow methods in SUPPORTED_METHODS order when multiple verbs are registered", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("MultiVerb");
    attachRoutes(cls, [
      {
        method: "DELETE",
        path: "/r",
        handler: function() {
          return new FlareResponse(200);
        },
      },
      {
        method: "GET",
        path: "/r",
        handler: function() {
          return new FlareResponse(200);
        },
      },
      {
        method: "POST",
        path: "/r",
        handler: function() {
          return new FlareResponse(200);
        },
      },
    ]);
    arc.controller("/", cls);
    arc[COMPILE_HTTP_ARC]();

    const res = arc.fetch(makeCtx("PUT", "/r")) as FlareResponse;
    expect(res.status).toBe(405);
    expect((res.headers as Record<string, string>).Allow).toBe("GET, POST, DELETE, HEAD");
  });

  it("returns 400 for trailing slashes and empty path segments before routing", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("PathGuard");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/users",
        handler: function() {
          return new FlareResponse(200);
        },
      },
    ]);
    arc.controller("/", cls);
    arc[COMPILE_HTTP_ARC]();

    for (const url of ["/users/", "/users//1", "//users"]) {
      const res = arc.fetch(makeCtx("GET", url)) as FlareResponse;
      expect(res.status).toBe(400);
      expect(res.body).toBe(INVALID_REQUEST_PATH_MESSAGE);
    }

    const ok = arc.fetch(makeCtx("GET", "/users")) as FlareResponse;
    expect(ok.status).toBe(200);
  });

  it("returns 400 for an empty pathname before routing", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("Root");
    attachRoutes(cls, [{
      method: "GET",
      path: "/",
      handler: function() {
        return new FlareResponse(200);
      },
    }]);
    arc.controller("/", cls);
    arc[COMPILE_HTTP_ARC]();

    const res = arc.fetch(makeCtx("GET", "")) as FlareResponse;
    expect(res.status).toBe(400);
    expect(res.body).toBe(INVALID_REQUEST_PATH_MESSAGE);
  });

  it("returns 400 when route parameter decoding fails", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("ParamRoute");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/items/:id",
        handler: function() {
          return new FlareResponse(200);
        },
      },
    ]);
    arc.controller("/", cls);
    arc[COMPILE_HTTP_ARC]();

    const res = arc.fetch(makeCtx("GET", "/items/%ZZ")) as FlareResponse;
    expect(res.status).toBe(400);
    expect(res.body).toBe("Invalid route parameters. Check that your URL path matches the expected format.");
  });

  it("OPTIONS without origin and no OPTIONS handler returns the auto-Allow 204 response", () => {
    const arc = new HttpArc(makeFakeHost());
    const cls = makeControllerCls("OptCtl");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/opt",
        handler: function() {
          return new FlareResponse(200);
        },
      },
    ]);
    arc.controller("/", cls);
    arc[COMPILE_HTTP_ARC]();

    const res = arc.fetch(makeCtx("OPTIONS", "/opt"));
    expect(res).toBeInstanceOf(FlareResponse);
    const r = res as FlareResponse;
    expect(r.status).toBe(204);
    const allow = (r.headers as Record<string, string>).Allow!;
    const parts = new Set(allow.split(",").map((s) => s.trim()));
    expect(parts.has("GET")).toBe(true);
    expect(parts.has("HEAD")).toBe(true);
    expect(parts.has("OPTIONS")).toBe(true);
    expect((r.headers as Record<string, string>)["Content-Length"]).toBe("0");
  });
});
