/**
 * Unit tests for service replacement during {@link COMPILE_FOR_TEST}.
 */
import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { Container } from "../../../../../src/lib/services/container.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { COMPILE_FOR_TEST } from "../../../../../src/lib/host/types/const.js";
import { FlareService as FlareServiceBase } from "../../../../../src/lib/services/composition/flare-service.js";
import { FlareTestError } from "../../../../../src/lib/testing/error.js";
import { makeAdapter, makeServiceClass, registerMinimalPingRoute } from "./_fixtures.js";

describe("replacing registered services during test compile", () => {
  it("locates the token in the singleton array and mutates the registration in place to use the replacement", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Original = makeServiceClass("OrigSingleton");
    const Replacement = class extends (Original as unknown as new(c: Container) => FlareServiceBase) {
      static deps = [];
    };
    Object.defineProperty(Replacement, "name", { value: "OrigSingletonRepl" });

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Original as never);
    host.build();
    host[COMPILE_FOR_TEST]({
      replace: new Map([
        [Original as unknown as ServiceToken<FlareService>, Replacement as unknown as ServiceClass],
      ]),
    });
    const inst = host.singletonServices.get(Original as unknown as ServiceToken<FlareService>);
    expect(inst).toBeInstanceOf(Replacement);
  });

  it("two-phase validation: a single invalid replacement aborts before any mutation occurs", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Good = makeServiceClass("Good");
    const GoodRepl = class extends (Good as unknown as new(c: Container) => FlareServiceBase) {
      static deps = [];
    };
    Object.defineProperty(GoodRepl, "name", { value: "GoodRepl" });
    const Unregistered = makeServiceClass("Unregistered");

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Good as never);
    host.build();

    const replace = new Map<ServiceToken<FlareService>, ServiceClass>([
      [Good as unknown as ServiceToken<FlareService>, GoodRepl as unknown as ServiceClass],
      [Unregistered as unknown as ServiceToken<FlareService>, GoodRepl as unknown as ServiceClass],
    ]);

    expect(() => host[COMPILE_FOR_TEST]({ replace })).toThrow(FlareTestError);

    // The failure happened during the validation pass (before `#singletonsCompiled`
    // flipped to true). A fresh COMPILE_FOR_TEST with no replacements should
    // therefore still observe the original `Good` registration in place, proving
    // the failed call did not partially mutate the registrations array.
    host[COMPILE_FOR_TEST]();
    const inst = host.singletonServices.get(Good as unknown as ServiceToken<FlareService>);
    expect(inst).not.toBeInstanceOf(GoodRepl);
  });

  it("throws FlareTestError when the replacement target token is not a registered service", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const NotRegistered = makeServiceClass("NotRegistered");
    const Repl = class extends (NotRegistered as unknown as new(c: Container) => FlareServiceBase) {
      static deps = [];
    };
    Object.defineProperty(Repl, "name", { value: "Repl" });

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();

    expect(() =>
      host[COMPILE_FOR_TEST]({
        replace: new Map([
          [NotRegistered as unknown as ServiceToken<FlareService>, Repl as unknown as ServiceClass],
        ]),
      })
    ).toThrow(
      "NotRegistered is not a registered service. Replace targets must be registered via host.singleton() or host.scoped()",
    );
  });

  it("throws FlareTestError '<X> does not extend <Y>' when the replacement does not extend the token", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Original = makeServiceClass("OrigParent");
    // A class that extends FlareServiceBase directly, NOT Original.
    class Stranger extends FlareServiceBase {
      static deps = [];
    }
    Object.defineProperty(Stranger, "name", { value: "Stranger" });

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Original as never);
    host.build();

    expect(() =>
      host[COMPILE_FOR_TEST]({
        replace: new Map([
          [Original as unknown as ServiceToken<FlareService>, Stranger as unknown as ServiceClass],
        ]),
      })
    ).toThrow("Stranger does not extend OrigParent");
  });
});
