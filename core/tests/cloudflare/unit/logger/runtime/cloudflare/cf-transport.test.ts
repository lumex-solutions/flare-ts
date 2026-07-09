/**
 * Unit tests for {@link CfLoggerTransport}: the inherited inject() ban and the
 * synchronous lifecycle hook contract.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { FlareService } from "../../../../../../src/lib/services/composition/flare-service.js";
import type { ServiceToken } from "../../../../../../src/lib/services/types/token.js";
import { CfLoggerTransport } from "../../../../../../src/lib/logger/runtime/cloudflare/cf-transport.js";
import { Container } from "../../../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../../../src/lib/services/registration-map.js";

function makeContainer(): Container {
  return new Container(new FlareRegistrationMap(), new Map(), {} as JsonObject);
}

describe("synchronous transport base class contract", () => {
  it("inherits inject(): calling it still throws", () => {
    class CfDeny extends CfLoggerTransport {
      static override readonly transportName = "cf-deny";
      static override deps: never[] = [];
      override write(): void {
        // no-op
      }
    }

    const t = new CfDeny(makeContainer());
    const fakeToken = { name: "AnyService" } as unknown as ServiceToken<FlareService>;

    expect(() => t.inject(fakeToken)).toThrow(
      `[flare] CfDeny attempted to inject "AnyService", but transports cannot inject services. Register clients or other dependencies in onStart() instead, and access config via this.config().`,
    );
  });

  it("onStart and onStop, when declared, are sync (return void): runtime calls do not produce a Promise", () => {
    class CfLifecycle extends CfLoggerTransport {
      static override readonly transportName = "cf-lifecycle";
      static override deps: never[] = [];
      started = false;
      stopped = false;
      override write(): void {
        // no-op
      }
      override onStart(): void {
        this.started = true;
      }
      override onStop(): void {
        this.stopped = true;
      }
    }

    const t = new CfLifecycle(makeContainer());

    const startResult = t.onStart();
    const stopResult = t.onStop();

    expect(startResult).toBeUndefined();
    expect(stopResult).toBeUndefined();
    expect(t.started).toBe(true);
    expect(t.stopped).toBe(true);
  });
});
