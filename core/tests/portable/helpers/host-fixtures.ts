/**
 * Shared host fixtures for portable and node integration tests.
 */
import type { IFlareApp } from "../../../src/lib/host/flare-app.js";
import type { FlareHost } from "../../../src/lib/host/flare-host.js";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { HostRuntimeLifecycle } from "../../../src/lib/host/types/lifecycle.js";
import type { LoggerTransportClass } from "../../../src/lib/logger/types.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";

/** Registers GET /ping so `host.build()` does not throw when HTTP is compiled. */
// FlareHost is generic on its adapter; mirror the class's `extends` constraint
// here so any caller's concrete FlareHost binds the parameter cleanly.
export function registerMinimalPingRoute<
  TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>,
>(host: FlareHost<TAdapter>): void {
  host.http.get("/ping", () => new FlareResponse(200, { ok: true }));
}
