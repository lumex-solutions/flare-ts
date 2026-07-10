/**
 * The runtime adapter contract: what each runtime supplies to compose a host.
 */
import type { JsonObject } from "@flare-ts/lib/schema";
import type { FlareRequest } from "../../arcs/http/transport/flare-request";
import type { Logger } from "../../logger/logger";
import type { LoggerTransport } from "../../logger/transport";
import type { LoggerTransportClass } from "../../logger/types";
import type { Container } from "../../services/container";
import type { TestRequestInput } from "../../testing/types/flare-test-req";
import type { IFlareApp } from "../flare-app-base.js";
import type { IFlareHost } from "../flare-host";
import type { HostRuntimeLifecycle } from "./lifecycle";
import type { HostRuntime } from "./runtime.js";

/**
 * Pluggable interface that lets a Flare host run on multiple JavaScript runtimes by supplying the
 * runtime's `flare.json` source, environment map, default transports, and factories for the app,
 * logger, and synthesized test request.
 *
 * @typeParam TApp - Concrete {@link IFlareApp} produced by {@link createApp}.
 * @typeParam TTransportClass - Logger transport class type understood by this runtime.
 * @typeParam TLifecycle - `"sync"` or `"async"`; constrains whether service hooks may return Promises.
 * @typeParam TExt - Members the adapter stamps onto the host at construction via `extendHost`.
 */
export interface HostRuntimeAdapter<
  TApp extends IFlareApp,
  TTransportClass extends LoggerTransportClass = LoggerTransportClass,
  TLifecycle extends HostRuntimeLifecycle = "async",
  TExt = {},
> {
  /** Identifier of the runtime this adapter targets. */
  runtime: HostRuntime;
  /** Whether lifecycle hooks (`onStart`, `onStop`) are allowed to return Promises. */
  lifecycle: TLifecycle;
  /** Raw contents of `flare.json` for this runtime. Implementations may use a lazy getter. */
  flareJsonFile: JsonObject;
  /** Environment variables exposed by the runtime, used by the config-resolution env-merge pass. */
  env: Record<string, string | undefined>;
  /** Transport classes always installed by this runtime (e.g. console for Node). */
  defaultLoggerTransports: readonly TTransportClass[];
  /** Builds the runtime-specific app instance bound to the host. */
  createApp: (host: IFlareHost) => TApp;
  /** Builds the runtime-specific logger from the resolved transports and bootstrap container. */
  createLogger: (transports: LoggerTransport[], container: Container) => Logger;
  /** Synthesizes a {@link FlareRequest} from a {@link TestRequestInput} for in-process tests. */
  createTestRequest: (input: TestRequestInput) => FlareRequest;
  /**
   * Members the adapter stamps onto the host instance at construction. The host's constructor calls
   * this and copies the returned members onto itself, and the host type intersects `TExt`, so a
   * stamped member exists only on hosts whose adapter provides it.
   */
  extendHost?(host: IFlareHost): TExt;
  /**
   * Runs at the very start of `host.build()`, before config/validation/compilation, so the adapter can
   * contribute framework services and build hooks (e.g. register context-bound capabilities, defer
   * singleton compilation).
   */
  setup?(host: IFlareHost): void;
}
