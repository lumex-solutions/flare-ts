/**
 * The test-mode runtime app host.build() returns under FLARE_MODE=test.
 */
import type { AppTestOptions } from "../host/flare-app-base.js";
import type { IFlareHost, IFlareTestHost } from "../host/flare-host.js";
import type { AnyAdapter, HostedApp } from "./test-app-handle.js";
import { FlareAppBase } from "../host/flare-app-base.js";
import { COMPILE_FOR_TEST, RESET_FOR_TEST, SET_HOST_STATE } from "../host/types/const.js";
import { FlareTestError } from "./flare-test-error.js";
import { TestAppHandle } from "./test-app-handle.js";

/**
 * Test-mode app returned by `host.build()` when `FLARE_MODE=test`.
 *
 * Sibling to `FlareAppNode` and `FlareAppCF`, using the same runtime-app pattern:
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

  /**
   * No-op shim in test mode; returns `null`.
   *
   * Use `test()` instead.
   */
  run(): null {
    return null;
  }

  /**
   * No-op shim in test mode; returns `null`.
   *
   * Use `test()` instead.
   */
  export(): null {
    return null;
  }

  /**
   * Compiles the host for test (applying any `replace` map), starts the service
   * graph, and issues a {@link TestAppHandle}.
   *
   * @throws {FlareTestError} When called a second time for the same host instance;
   *   use `handle.reset({ replace })` to swap services between scenarios instead.
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
   * new replacements, start.
   *
   * The lifecycle is identical to a fresh `test()` call but mutates state in
   * place so the existing `TestAppHandle` remains valid.
   *
   * `FlareAppBase` increments an internal singleton index across calls.
   * Across a reset, the index ratchets but `stopAsync` is defensive about
   * out-of-range slots, and the Logger.onStart/onStop pair fires once per
   * lifecycle cycle (twice across a single reset). Logger transports must be
   * idempotent across start/stop.
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
