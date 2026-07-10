/**
 * Behavior and type tests for the first-class host extension API.
 *
 * An extension package exports a descriptor from `defineHostExtension((host) => members)`. Passing it
 * to the `FlareHost` constructor installs each returned member on the host (via the no-shadow guard);
 * because the extensions array is a `const` type parameter, every member is typed straight from the
 * array, so a host that did not pass the descriptor has none of its members.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, expectTypeOf, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { str } from "@flare-ts/lib/schema";
import type { SingletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { LogRecord } from "../../../../../src/lib/logger/types.js";
import type { LoggerTransportClass } from "../../../../../src/lib/logger/types.js";
import { flareConfig } from "../../../../../src/index.js";
import { defineHostExtension } from "../../../../../src/lib/host/extensions/extension.js";
import { singletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import { FlareAppBase } from "../../../../../src/lib/host/flare-app-base.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { LoggerTransport } from "../../../../../src/lib/logger/transport.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

class SilentTransport extends LoggerTransport {
  static override readonly transportName = "silent-ext";
  static override deps = [];
  override write(_record: LogRecord): void {}
}

function adapter(
  json: JsonObject = {},
): HostRuntimeAdapter<FlareAppBase, LoggerTransportClass, "async", SingletonExtension> {
  return {
    runtime: "node",
    lifecycle: "async",
    get flareJsonFile(): JsonObject {
      return json;
    },
    env: {},
    defaultLoggerTransports: [SilentTransport],
    createApp(host) {
      return new (class extends FlareAppBase {})(host);
    },
    createLogger(transports, container) {
      return new Logger(transports, container);
    },
    createTestRequest() {
      throw new Error("not used");
    },
    extendHost(host) {
      return singletonExtension(host);
    },
  };
}

const COUNTER_CONFIG = flareConfig("counter", { label: str });

class CounterService extends FlareService {
  static override deps = [];
}

// The kind of descriptor an extension package would export. The installer composes once (cfg/scoped)
// and returns a MAP of members -- here three of mixed kind: a factory method, a void method, and a
// non-callable value -- each typed onto the host straight from the array.
const counterExt = defineHostExtension((host) => {
  host.cfg(COUNTER_CONFIG);
  host.scoped(CounterService);
  let n = 0;
  return {
    counter: (start: number) => {
      n = start;
      return { next: () => n++ };
    },
    resetCounter: (): void => {
      n = 0;
    },
    counterToken: COUNTER_CONFIG,
  };
});

// Compile-only negative checks: never executed, but `tsc -p core/tests/tsconfig.json` validates the
// `@ts-expect-error` directives (an unused one is itself a tsc error). They assert each member is typed
// with its real signature, and that the members exist only on a host that passed the descriptor.
function _typeNegatives(): void {
  const host = new FlareHost(adapter({ counter: { label: "n" } }), [counterExt]);
  // @ts-expect-error -- counter requires a number argument
  host.counter("nope");
  // @ts-expect-error -- the return type is { next(): number }; there is no `prev`
  host.counter(1).prev();
  // @ts-expect-error -- the extension installs no `missing` member
  host.missing();

  // A host that did not pass counterExt has none of its members: calling one is a compile error.
  const bare = new FlareHost(adapter());
  // @ts-expect-error -- `counter` is not a member: this host did not opt into the extension
  bare.counter(1);
  // @ts-expect-error -- `resetCounter` is not a member either
  bare.resetCounter();
}
void _typeNegatives;

describe("host extension API", () => {
  it("installs every returned member (callable and not) from the constructor list", () => {
    const host = new FlareHost(adapter({ counter: { label: "n" } }), [counterExt]);
    registerMinimalPingRoute(host);

    const handle = host.counter(10);
    expect(handle.next()).toBe(10);
    expect(handle.next()).toBe(11);
    host.resetCounter();
    expect(host.counter(5).next()).toBe(5);
    // A non-callable member is installed too.
    expect(host.counterToken).toBe(COUNTER_CONFIG);
    // The graph the extension's installer contributed (config + service) compiles cleanly.
    expect(() => host.build()).not.toThrow();
  });

  it("types each member precisely, derived from the constructor extensions array", () => {
    const host = new FlareHost(adapter({ counter: { label: "n" } }), [counterExt]);
    // Type-level assertions (verified by `tsc -p core/tests/tsconfig.json`) on member references; we do
    // not call the installer here. See `_typeNegatives` above for the array-derived negatives.
    expectTypeOf(host.counter).parameter(0).toBeNumber();
    expectTypeOf(host.counter).returns.toEqualTypeOf<{ next(): number; }>();
    expectTypeOf(host.resetCounter).returns.toBeVoid();
    expectTypeOf(host.counterToken).toEqualTypeOf(COUNTER_CONFIG);
  });

  it("hands the installer only scoped/cfg/http, no privileged or test surface", () => {
    let keys: string[] = [];
    const probe = defineHostExtension((host) => {
      keys = Object.keys(host).sort();
      return {};
    });
    new FlareHost(adapter(), [probe]);
    expect(keys).toEqual(["cfg", "http", "scoped"]);
  });

  it("fails loud at construction when a member shadows an existing host member", () => {
    const bad = defineHostExtension(() => ({ build: () => undefined }));
    expect(() => new FlareHost(adapter(), [bad])).toThrow(
      /host extension tried to stamp "build", which already exists/,
    );
  });

  it("fails loud when two extensions install the same member name", () => {
    const a = defineHostExtension(() => ({ thing: () => 1 }));
    const b = defineHostExtension(() => ({ thing: () => 2 }));
    expect(() => new FlareHost(adapter(), [a, b])).toThrow(
      /host extension tried to stamp "thing", which already exists/,
    );
  });
});
