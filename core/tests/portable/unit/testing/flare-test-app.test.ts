/**
 * Unit tests for {@link FlareTestApp} run()/export() shims. test() and reset need a
 * full host and are pinned by the node integration suites.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { IFlareApp } from "../../../../src/lib/host/flare-app.js";
import type { IFlareHost, IFlareTestHost } from "../../../../src/lib/host/flare-host.js";
import type { HostRuntimeAdapter } from "../../../../src/lib/host/types/adapter.js";
import type { HostRuntimeLifecycle } from "../../../../src/lib/host/types/lifecycle.js";
import type { LoggerTransportClass } from "../../../../src/lib/logger/types.js";
import { FlareTestApp } from "../../../../src/lib/testing/flare-test-app.js";

type AnyAdapter = HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>;

describe("FlareTestApp.run / FlareTestApp.export", () => {
  // Minimal stub host: only the surface FlareAppBase touches at construction time
  // (it reads `host.http`). It does NOT need to be functional for run()/export()
  // because both shims unconditionally return null.
  let app: FlareTestApp;

  beforeEach(() => {
    const host = { http: {} } as unknown as IFlareHost & IFlareTestHost;
    const adapter = {} as unknown as AnyAdapter;
    app = new FlareTestApp(host, adapter);
  });

  it("run() returns null in test mode (no-op shim)", () => {
    expect(app.run()).toBeNull();
  });

  it("export() returns null in test mode (no-op shim)", () => {
    expect(app.export()).toBeNull();
  });

  it("run() and export() can be called repeatedly without side effects", () => {
    expect(app.run()).toBeNull();
    expect(app.export()).toBeNull();
    expect(app.run()).toBeNull();
  });
});
