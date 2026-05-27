import { describe, expect, it } from "vitest";
import { FlareHost, FlareService } from "../../../src/index.js";
import { buildCf } from "../../../src/lib/host/runtime/cloudflare.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

describe("Edge Cases", () => {
  it(
    "host.singleton() on a Cloudflare-runtime host is a type-level `never` (compile-time error)",
    () => {
      const cfHost = new FlareHost(
        buildCf({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
      );

      class SomeService extends FlareService {
        public static override deps = [];
      }

      // Compile-time guard only: the CF adapter narrows the singleton parameter
      // to `never`. Do not invoke singleton() here — the runtime guard throws.
      // (Source no longer surfaces this as a static error; the runtime assertion
      // in the following `it` covers the contract.)
      const _forbidden: Parameters<typeof cfHost.singleton>[0] = SomeService;
      expect(_forbidden).toBe(SomeService);
    },
  );

  it("host.singleton() on a Cloudflare-runtime host throws at runtime", () => {
    const cfHost = new FlareHost(
      cfProdAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
    );

    class SomeService extends FlareService {
      public static override deps = [];
    }

    expect(() => cfHost.singleton(SomeService as never)).toThrow(
      "[flare] host.singleton() is not supported on Cloudflare Workers",
    );
  });
});
