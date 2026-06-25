import type { HttpArc } from "../arcs/http/http-arc.js";
import type { ResponseLike } from "../arcs/http/transport/types/response.js";
import type { AppTestOptions } from "../host/flare-app.js";
import type { IFlareHost, IFlareTestHost } from "../host/flare-host.js";
import type { HostRuntimeAdapter } from "../host/types/adapter.js";
import type { HostRuntimeLifecycle } from "../host/types/lifecycle.js";
import type { LoggerTransportClass } from "../logger/types.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { FlareServiceClass, ServiceToken } from "../services/types/types.js";
import type { FlareTestReq } from "./types/flare-test-req.js";
import { DRAIN_SET_COOKIES, FlareHttpContext } from "../arcs/http/transport/flare-http-context.js";
import { FlareResponse } from "../arcs/http/transport/flare-response.js";
import { FlareAppBase, type IFlareApp } from "../host/flare-app.js";
import { COMPILE_FOR_TEST, RESET_FOR_TEST, SET_HOST_STATE } from "../host/types/const.js";
import { FlareTestError } from "./error.js";

type HostedApp = IFlareApp & { http: HttpArc; };
type AnyAdapter = HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>;
type ResetFn = (
  opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, FlareServiceClass>; },
) => Promise<void>;

/**
 * Integration-test handle returned by `app.test()` (where `app` came from
 * `host.build()`). Mirrors how `FlareAppNode.run()` returns a `NodeRunHandle`
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
   * @param target `"METHOD /path"`, e.g. `"GET /users/123"`, `"POST /chat"`.
   * @param init   Optional headers, body, and signal. `body` is `unknown`: bytes pass
   *               through, strings pass through, anything else is JSON-stringified
   *               and `content-type: application/json` is set if absent.
   */
  async fetch(target: string, init?: FlareTestReq): Promise<Response> {
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

  /** Runs `onStop()` on all services in reverse dependency order. Call in `afterAll`. */
  async stop(): Promise<void> {
    await this.#app.stopAsync();
  }

  /**
   * Tears the test app down (runs `onStop`), restores the original registrations,
   * applies a new `replace` map, and re-runs the lifecycle. The same handle
   * keeps working; subsequent `app.fetch()` calls hit the new graph.
   *
   * Use to swap services between scenarios inside a single test file without
   * needing to split into separate files for each replacement set.
   */
  async reset(
    opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, FlareServiceClass>; },
  ): Promise<void> {
    await this.#resetFn(opts);
  }

  // Inline ResponseLike -> Response. Kept inside TestAppHandle per the architectural
  // decision: response normalization stays in the arc / runtimes; testing handles
  // its own conversion rather than carving a shared helper out of framework code.
  // Mirrors a slim subset of `FlareAppCF.#buildResponse` intentionally.
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

/**
 * Test-mode app returned by `host.build()` when `FLARE_MODE=test`. Sibling to
 * `FlareAppNode` and `FlareAppCF`, using the same runtime-app pattern:
 * `host.build()` returns this; `.test()` returns a {@link TestAppHandle}
 * (matching the way `FlareAppNode.run()` returns a `NodeRunHandle` and
 * `FlareAppCF.export()` returns a `{ fetch }` handle).
 *
 * The `run()` and `export()` shims return `null` so the user's host-file
 * pattern `export default host.build().export()` is callable without binding
 * a port or returning a real handler; those return values are discarded in
 * test mode.
 */
export class FlareTestApp extends FlareAppBase {
  #adapter: AnyAdapter;
  #handleIssued = false;
  /** Test-only host view (`compileForTest` / `resetForTest`), kept off the runtime-facing `host`. */
  #testHost: IFlareTestHost;

  constructor(host: IFlareHost & IFlareTestHost, adapter: AnyAdapter) {
    super(host);
    this.#adapter = adapter;
    this.#testHost = host;
  }

  /** No-op shim in test mode; returns `null`. Use `test()` instead. */
  run(): null {
    return null;
  }

  /** No-op shim in test mode; returns `null`. Use `test()` instead. */
  export(): null {
    return null;
  }

  /**
   * Compiles the host for test (applying any `replace` map), starts the service
   * graph, and issues a {@link TestAppHandle}. Throws {@link FlareTestError} on
   * a second call for the same host instance; use `handle.reset({ replace })`
   * to swap services between scenarios instead.
   */
  override async test(opts?: AppTestOptions): Promise<TestAppHandle> {
    if (this.#handleIssued) {
      throw new FlareTestError(
        "app.test() may only be called once per host instance. Use handle.reset({ replace }) to swap services between scenarios.",
      );
    }

    this.#testHost[COMPILE_FOR_TEST](opts);
    await this.startAsync();
    this.host[SET_HOST_STATE]("ready");

    this.#handleIssued = true;

    // `http` is `protected` on FlareAppBase. The cast widens it to public for
    // TestAppHandle's structural type; safe because TestAppHandle is the only
    // consumer and `protected` has no runtime meaning.
    return new TestAppHandle(
      this as unknown as HostedApp,
      this.#adapter,
      (resetOpts) => this.#reset(resetOpts),
    );
  }

  /**
   * Drives `TestAppHandle.reset()`: stop, restore registrations, compile with
   * new replacements, start. The lifecycle is identical to a fresh `test()`
   * call but mutates state in place so the existing `TestAppHandle` remains valid.
   *
   * `FlareAppBase` increments an internal singleton index across calls.
   * Across a reset, the index ratchets but `stopAsync` is defensive about
   * out-of-range slots, and the Logger.onStart/onStop pair fires once per
   * lifecycle cycle (twice across a single reset). Logger transports must be
   * idempotent across start/stop; almost always true in practice.
   */
  async #reset(opts?: AppTestOptions): Promise<void> {
    if (!this.#handleIssued) {
      throw new FlareTestError("handle.reset() called before app.test(); nothing to reset.");
    }

    this.host[SET_HOST_STATE]("draining");
    await this.stopAsync();
    this.#testHost[RESET_FOR_TEST]();
    this.#testHost[COMPILE_FOR_TEST](opts);
    await this.startAsync();
    this.host[SET_HOST_STATE]("ready");
  }
}
