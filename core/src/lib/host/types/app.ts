/**
 * The compiled-app return vocabulary: what host.build() yields per adapter.
 */
import type { LoggerTransportClass } from "../../logger/types.js";
import type { TestAppHandle } from "../../testing/test-app-handle.js";
import type { AppTestOptions } from "../flare-app-base.js";
import type { HostRuntimeAdapter } from "./adapter.js";
import type { HostRuntimeLifecycle } from "./lifecycle.js";

/**
 * Compiled application returned by {@link FlareHost.build}.
 *
 * Typed with its runtime adapter (`FlareApp<typeof node>`), it is that runtime's app, carrying its
 * entrypoint (`run()` on Node, `export()` on Cloudflare). Without a type argument, it is the face
 * every runtime's app shares, for code that accepts an app from any runtime.
 *
 * @typeParam TAdapter - The runtime adapter type; omit it to accept an app from any runtime.
 */
export type FlareApp<TAdapter = never> = [TAdapter] extends [never]
  ? { test(opts?: AppTestOptions): Promise<TestAppHandle>; }
  : TAdapter extends HostRuntimeAdapter<infer TApp, LoggerTransportClass, HostRuntimeLifecycle> ? TApp
  : never;
