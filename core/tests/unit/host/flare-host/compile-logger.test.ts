import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import type { Container } from "../../../../src/lib/services/container.js";
import type { ServiceToken } from "../../../../src/lib/services/types/types.js";
import { FlareHost } from "../../../../src/lib/host/flare-host.js";
import { COMPILE_FOR_TEST } from "../../../../src/lib/host/types/const.js";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { LoggerTransport } from "../../../../src/lib/logger/transport.js";
import { makeAdapter, makeServiceClass, registerMinimalPingRoute } from "./_fixtures.js";

let capturedBootContainer: Container | undefined;

class BootstrapProbeTransport extends LoggerTransport {
  static override readonly transportName = "bootstrap-probe";
  static override deps = [];

  constructor(container: Container) {
    super(container);
    capturedBootContainer = container;
  }

  write(): void {}
}

describe("FlareHost #compileLogger (private — covered via build)", () => {
  it("places the Logger instance directly into the singletons map under the Logger token", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.build();
    const inst = host.singletonServices.get(Logger);
    expect(inst).toBeInstanceOf(Logger);
    // Confirm host.logger and the singletons-map entry are the same instance.
    expect(host.logger).toBe(inst);
  });

  it("registers Logger in singletons after build() before user singletons are compiled", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Svc = makeServiceClass("DeferredUserSvc");
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Svc as never);

    host.build();

    expect(host.singletonServices.has(Logger)).toBe(true);
    expect(host.singletonServices.has(Svc as unknown as ServiceToken<FlareService>)).toBe(false);

    host[COMPILE_FOR_TEST]();
    expect(host.singletonServices.has(Svc as unknown as ServiceToken<FlareService>)).toBe(true);
  });

  it("bootstrap container rejects resolveDep for unregistered user services", () => {
    capturedBootContainer = undefined;
    const adapter = makeAdapter({
      defaultLoggerTransports: [BootstrapProbeTransport as never],
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);

    host.build();

    expect(capturedBootContainer).toBeDefined();
    class UnregisteredUserSvc {
      static deps: readonly ServiceToken<FlareService>[] = [];
    }
    expect(() =>
      capturedBootContainer!.resolveDep(
        UnregisteredUserSvc as unknown as ServiceToken<FlareService>,
      )
    ).toThrow("ServiceToken UnregisteredUserSvc not registered in container.");
  });
});
