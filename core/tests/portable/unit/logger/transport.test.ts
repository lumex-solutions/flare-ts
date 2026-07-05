/**
 * Unit tests for {@link LoggerTransport} base class contract and subclass hooks.
 */
import { describe, it, expect } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { LogRecord } from "../../../../src/lib/logger/types.js";
import type { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import type { ServiceToken } from "../../../../src/lib/services/types/types.js";
import { CFWLoggerTransport, LoggerTransport } from "../../../../src/lib/logger/transport.js";
import { Container } from "../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../src/lib/services/registration-map.js";

function makeContainer(): Container {
  return new Container(new FlareRegistrationMap(), new Map(), {} as JsonObject);
}

describe("transport base class contract", () => {
  it("cannot be instantiated directly: concrete subclass with a stub write is the test vehicle", () => {
    class StubTransport extends LoggerTransport {
      static override readonly transportName = "stub";
      static override deps: never[] = [];
      lastRecord: LogRecord | undefined;
      override write(record: LogRecord): void {
        this.lastRecord = record;
      }
    }

    const t = new StubTransport(makeContainer());

    const rec: LogRecord = { timestamp: 0, level: "info", message: "x" };
    t.write(rec);
    expect(t.lastRecord).toBe(rec);
  });

  it("inject(token) throws with a message containing the constructor name and the attempted token name", () => {
    class DenyTransport extends LoggerTransport {
      static override readonly transportName = "deny";
      static override deps: never[] = [];
      override write(): void {
        // no-op
      }
    }

    const t = new DenyTransport(makeContainer());

    // Build a minimal ServiceToken<FlareService>: only `.name` is read by the error path.
    const fakeToken = { name: "SomeService" } as unknown as ServiceToken<FlareService>;

    expect(() => t.inject(fakeToken)).toThrow(
      `[flare] DenyTransport attempted to inject "SomeService", but transports cannot inject services. Register clients or other dependencies in onStart() instead, and access config via this.config().`,
    );
  });

  it("a concrete subclass without overriding onStart/onStop does not throw: the hooks are optional", () => {
    class MinimalTransport extends LoggerTransport {
      static override readonly transportName = "minimal";
      static override deps: never[] = [];
      override write(): void {
        // no-op
      }
    }

    const t = new MinimalTransport(makeContainer());

    // The hooks are optional; the optional-chained calls used by Logger
    // (`transport.onStart?.()`) must short-circuit on a subclass that omits them.
    expect(t.onStart).toBeUndefined();
    expect(t.onStop).toBeUndefined();
    expect(() => t.onStart?.()).not.toThrow();
    expect(() => t.onStop?.()).not.toThrow();
  });

  it("static deps defaults to an empty array on the base; concrete subclasses can override without runtime error", () => {
    expect(Array.isArray(LoggerTransport.deps)).toBe(true);
    expect(LoggerTransport.deps).toHaveLength(0);

    class WithDeps extends LoggerTransport {
      static override readonly transportName = "with-deps";
      static override deps: never[] = []; // typed as `never[]` per the base; runtime override is allowed.
      override write(): void {
        // no-op
      }
    }

    // The override compiles and the value is what we set.
    expect(WithDeps.deps).toEqual([]);

    // And construction succeeds.
    expect(() => new WithDeps(makeContainer())).not.toThrow();
  });

  it("static transportName is read by name lookup; a subclass that omits the static yields undefined", () => {
    class NamedTransport extends LoggerTransport {
      static override readonly transportName = "named";
      static override deps: never[] = [];
      override write(): void {
        // no-op
      }
    }

    class UnnamedTransport extends LoggerTransport {
      // Intentionally omit static transportName.
      static override deps: never[] = [];
      override write(): void {
        // no-op
      }
    }

    // Mirrors what logger.ts's getTransportName() does internally.
    const namedKey = (NamedTransport.prototype.constructor as typeof LoggerTransport).transportName;
    const unnamedKey = (UnnamedTransport.prototype.constructor as typeof LoggerTransport).transportName;

    expect(namedKey).toBe("named");
    expect(unnamedKey).toBeUndefined();
  });
});

describe("synchronous transport base class contract", () => {
  it("inherits inject(): calling it still throws", () => {
    class CFWDeny extends CFWLoggerTransport {
      static override readonly transportName = "cfw-deny";
      static override deps: never[] = [];
      override write(): void {
        // no-op
      }
    }

    const t = new CFWDeny(makeContainer());
    const fakeToken = { name: "AnyService" } as unknown as ServiceToken<FlareService>;

    expect(() => t.inject(fakeToken)).toThrow(
      `[flare] CFWDeny attempted to inject "AnyService", but transports cannot inject services. Register clients or other dependencies in onStart() instead, and access config via this.config().`,
    );
  });

  it("onStart and onStop, when declared, are sync (return void): runtime calls do not produce a Promise", () => {
    class CFWLifecycle extends CFWLoggerTransport {
      static override readonly transportName = "cfw-lifecycle";
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

    const t = new CFWLifecycle(makeContainer());

    const startResult = t.onStart();
    const stopResult = t.onStop();

    expect(startResult).toBeUndefined();
    expect(stopResult).toBeUndefined();
    expect(t.started).toBe(true);
    expect(t.stopped).toBe(true);
  });
});
