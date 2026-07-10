/**
 * The integration-test handle app.test() issues: synthetic requests through the
 * full pipeline without binding a port.
 */
import type { HttpArc } from "../arcs/http/http-arc.js";
import type { ResponseLike } from "../arcs/http/transport/types/response.js";
import type { IFlareApp } from "../host/flare-app.js";
import type { HostRuntimeAdapter } from "../host/types/adapter.js";
import type { HostRuntimeLifecycle } from "../host/types/lifecycle.js";
import type { LoggerTransportClass } from "../logger/types.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceClass } from "../services/types/service-class.js";
import type { ServiceToken } from "../services/types/token.js";
import type { TestRequestInit } from "./types/flare-test-req.js";
import { FlareHttpContext } from "../arcs/http/transport/flare-http-context.js";
import { FlareResponse } from "../arcs/http/transport/flare-response.js";
import { DRAIN_SET_COOKIES } from "../arcs/http/transport/types/cookies.js";
import { FlareTestError } from "./flare-test-error.js";

/** The app view TestAppHandle drives: a built app with its HTTP arc reachable. */
export type HostedApp = IFlareApp & { http: HttpArc; };

/** Any runtime adapter shape the handle can create test requests through. */
export type AnyAdapter = HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>;

/** The reset closure FlareTestApp hands the handle at construction. */
export type ResetFn = (
  opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>; },
) => Promise<void>;

/**
 * Integration-test handle returned by `app.test()` (where `app` came from `host.build()`).
 *
 * Mirrors how `FlareAppNode.run()` returns a `NodeRunHandle`
 * and `FlareAppCF.export()` returns a `{ fetch }` handle; the test runtime's
 * analogue.
 *
 * Sends synthetic requests through the full pipeline (routing, middleware,
 * handler) without binding a port. Always resolves to a standard Web
 * {@link Response}; the internal `ResponseLike` union is normalized before
 * returning.
 *
 * Each `fetch` call constructs a `FlareRequest` via the host's adapter
 * (`createTestRequest`), so the request adapter and native shape match what
 * production code sees, preserving differences in `signal()`, `background()`,
 * and raw header handling between Node and CF.
 */
export class TestAppHandle {
  #app: HostedApp;
  #adapter: AnyAdapter;
  #resetFn: ResetFn;
  #seq = 0;

  constructor(
    app: HostedApp,
    adapter: AnyAdapter,
    resetFn: ResetFn,
  ) {
    this.#app = app;
    this.#adapter = adapter;
    this.#resetFn = resetFn;
  }

  /**
   * Sends a synthetic request through the pipeline.
   *
   * @param target - `"METHOD /path"`, e.g. `"GET /users/123"`, `"POST /chat"`.
   * @param init - Optional headers, body, and signal. `body` is `unknown`: bytes pass
   *   through, strings pass through, anything else is JSON-stringified
   *   and `content-type: application/json` is set if absent.
   * @throws {FlareTestError} When `target` is not a `"METHOD /path"` string.
   */
  async fetch(target: string, init?: TestRequestInit): Promise<Response> {
    const sp = target.indexOf(" ");
    if (sp === -1) {
      throw new FlareTestError(`Invalid target "${target}". Expected "METHOD /path".`);
    }
    const method = target.slice(0, sp).toUpperCase();
    const path = target.slice(sp + 1);
    if (!path.startsWith("/")) {
      throw new FlareTestError(`Invalid target "${target}". Path must start with "/".`);
    }

    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
    }

    let body: ArrayBuffer | Uint8Array | string | null = null;
    if (init?.body !== undefined) {
      if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
        body = init.body;
      } else if (typeof init.body === "string") {
        body = init.body;
      } else {
        body = JSON.stringify(init.body);
        if (!("content-type" in headers)) headers["content-type"] = "application/json";
      }
    }

    const flareReq = this.#adapter.createTestRequest({
      method,
      url: path,
      headers,
      body,
      requestId: `test-${++this.#seq}`,
      ...(init?.signal ? { signal: init.signal } : {}),
    });

    const ctx = new FlareHttpContext(flareReq);

    const result = this.#app.http.fetch(ctx);
    const resolved = result instanceof Promise ? await result : result;
    return this.#toResponse(resolved, ctx, flareReq.requestId);
  }

  /**
   * Runs `onStop()` on all services in reverse dependency order.
   *
   * Call in `afterAll`.
   */
  async stop(): Promise<void> {
    await this.#app.stopAsync();
  }

  /**
   * Tears the test app down and re-runs the lifecycle with a new `replace` map.
   *
   * Runs `onStop`, restores the original registrations, applies the new
   * replacements, and starts again. The same handle keeps working; subsequent
   * `app.fetch()` calls hit the new graph.
   *
   * Use to swap services between scenarios inside a single test file without
   * needing to split into separate files for each replacement set.
   */
  async reset(
    opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>; },
  ): Promise<void> {
    await this.#resetFn(opts);
  }

  // Inline conversion from ResponseLike to Response. Kept inside TestAppHandle per
  // the architectural decision: response normalization stays in the arc / runtimes;
  // testing handles its own conversion rather than carving a shared helper out of
  // framework code. Mirrors a slim subset of `FlareAppCF.#buildResponse` intentionally.
  #toResponse(response: ResponseLike, ctx: FlareHttpContext, requestId: string): Response {
    const setCookies = ctx[DRAIN_SET_COOKIES]();

    if (response instanceof FlareResponse) {
      const baseHeaders: Record<string, string> = { ...response.headers, "x-request-id": requestId };

      if (response.bodyStream) {
        const { readable, writable } = new TransformStream();
        (async () => {
          const writer = writable.getWriter();
          for await (const chunk of response.bodyStream!) await writer.write(chunk);
          await writer.close();
        })();
        const headers = setCookies ? this.#mergeSetCookies(baseHeaders, setCookies) : new Headers(baseHeaders);
        return new Response(readable, { status: response.status, headers });
      }

      const bodyInit = response.body instanceof Uint8Array
        ? response.body.buffer.slice(
          response.body.byteOffset,
          response.body.byteOffset + response.body.byteLength,
        )
        : response.body;
      const headers = setCookies ? this.#mergeSetCookies(baseHeaders, setCookies) : new Headers(baseHeaders);
      // The Uint8Array branch produces ArrayBufferLike and the fallthrough is the
      // FlareResponse body union; both land inside BodyInit | null, which the
      // checker cannot collapse across the ternary.
      return new Response(bodyInit as BodyInit | null, { status: response.status, headers });
    }

    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    if (setCookies) {
      for (let i = 0; i < setCookies.length; i++) headers.append("Set-Cookie", setCookies[i]!);
    }
    return new Response(response.body, { status: response.status, headers });
  }

  #mergeSetCookies(base: Record<string, string>, setCookies: string[]): Headers {
    const headers = new Headers(base);
    for (let i = 0; i < setCookies.length; i++) headers.append("Set-Cookie", setCookies[i]!);
    return headers;
  }
}
