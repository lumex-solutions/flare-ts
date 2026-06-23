// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction.
process.env["FLARE_MODE"] = "test";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import { str } from "@flare-ts/lib/schema";
import type { SingletonExtension } from "../../../src/lib/host/extensions/singleton.js";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { LoggerTransportClass } from "../../../src/lib/logger/types.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { ControllerBase } from "../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { Get } from "../../../src/lib/arcs/http/routing/decorators.js";
import { type ConfigToken, flareConfig, HOST_CONFIG } from "../../../src/lib/config/flare-config.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareBase } from "../../../src/lib/services/composition/flare-base.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { Container } from "../../../src/lib/services/container.js";

// Test adapter: wraps the real `node` adapter but lets each test supply the
// raw `flare.json` contents in code. The repo has no `core/flare.json`, so
// the default node adapter would throw ENOENT when reading it. The wrapper
// preserves every other adapter capability so the host build pipeline runs
// the same way a production node app would.

function nodeWith(flareJson: JsonObject): HostRuntimeAdapter<
  ReturnType<typeof node.createApp>,
  LoggerTransportClass,
  "async",
  SingletonExtension
> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env: node.env,
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    extendHost: node.extendHost!.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

// Tokens used across the file.
//   - DbConfig: a real descriptor token, supplied by flare.json in every test.
//   - GhostConfig: registered token with an EMPTY descriptor and no section
//     in flare.json. The host's #compileConfig auto-fills the top-level key
//     to `{}` so MissingConfigKeyValidator passes (no descriptor fields to
//     check). Used by Cross-Feature #1 to exercise the "Container does not
//     throw on a missing key/field" branch: every property of the resolved
//     `{}` section is `undefined`, which is what Container.resolveCfg returns
//     to the caller without throwing.

const DbConfig = flareConfig("db", { url: str, password: str });
const GhostConfig = flareConfig("ghost_section", {}) as ConfigToken<
  Record<string, string | undefined>
>;

// Services / controllers used by Primary Behavior.
//   - OnStartConfigService: declares `static config = [DbConfig]` and reads
//     `this.config(DbConfig)` inside `onStart`. A singleton so onStart runs.
//   - UndeclaredHostController: declares `static config = [DbConfig]` and
//     calls `this.config(HOST_CONFIG)` from a handler — must throw the exact
//     "not declared in <ClassName>.config" message.

class OnStartConfigService extends FlareService {
  public static override deps = [];
  public static override config = [DbConfig] as const;

  public capturedOnStart: { url: string; password: string; } | null = null;

  public override onStart(): void {
    // The host builds the resolved config object before any singleton
    // onStart runs, so this resolution must succeed and surface the typed
    // section data.
    this.capturedOnStart = this.config(DbConfig);
  }
}

class UndeclaredHostController extends ControllerBase {
  public static override deps = [];
  public static override state = [];
  public static override config = [DbConfig] as const;

  @Get("")
  public async show() {
    // HOST_CONFIG is NOT in this controller's static config array, so
    // `this.config(HOST_CONFIG)` must throw the developer-facing error.
    // Cast through `any` to bypass the typed protected accessor for the
    // negative scenario; the point of this test is the runtime guardrail.
    const _ = (this as unknown as { config: (t: unknown) => unknown; }).config(HOST_CONFIG);
    return this.ok({ unreachable: true });
  }
}

// Edge Cases — fixtures.
//   - EmptyConfigController: `static config = []` rejects every call.
//   - ParentDeclaresConfig / ChildInheritsConfig: subclass-without-redeclare
//     reads the parent's config array (class-side inheritance).
//   - FlareBaseProbe / FlareBaseProbeController: a FlareBase subclass that is
//     NOT a FlareService — proves the validation lives on FlareBase, not on
//     a lifecycle-bound subclass.

class EmptyConfigController extends ControllerBase {
  public static override deps = [];
  public static override state = [];
  public static override config = [] as const;

  @Get("")
  public async show() {
    // Even DbConfig — which is registered on the host — must be rejected
    // because the class declares an empty static config array.
    const _ = (this as unknown as { config: (t: unknown) => unknown; }).config(DbConfig);
    return this.ok({ unreachable: true });
  }
}

class ParentDeclaresConfig extends ControllerBase {
  public static override deps = [];
  public static override state = [];
  public static override config = [DbConfig] as const;

  @Get("")
  public async show() {
    // Inherited static config — Child must still see [DbConfig].
    const cfg = (this as unknown as { config: (t: unknown) => unknown; }).config(DbConfig) as {
      url: string;
      password: string;
    };
    return this.ok({ url: cfg.url });
  }
}

class ChildInheritsConfig extends ParentDeclaresConfig {
  // Intentionally NO `static override config`. Inherits from ParentDeclaresConfig.
}

// A FlareBase subclass (NOT a FlareService) used inside a controller handler
// to demonstrate that the static-config guardrail fires for any FlareBase
// descendant — it is not tied to the service lifecycle.
class FlareBaseProbe extends FlareBase {
  public static override config = [DbConfig] as const;

  public readGood(): unknown {
    return (this as unknown as { config: (t: unknown) => unknown; }).config(DbConfig);
  }

  public readBad(): unknown {
    // HOST_CONFIG is not in static config so this must throw with the
    // class-name-bearing message.
    return (this as unknown as { config: (t: unknown) => unknown; }).config(HOST_CONFIG);
  }
}

class FlareBaseProbeController extends ControllerBase {
  public static override deps = [];
  public static override state = [];

  @Get("/good")
  public async showGood() {
    const probe = new FlareBaseProbe(this.container);
    const cfg = probe.readGood() as { url: string; password: string; };
    return this.ok({ url: cfg.url });
  }

  @Get("/bad")
  public async showBad() {
    const probe = new FlareBaseProbe(this.container);
    probe.readBad();
    return this.ok({ unreachable: true });
  }
}

// Failure Modes — fixtures.
//   - UndeclaredCallController: declares `static config = [DbConfig]` and
//     calls `this.config(HOST_CONFIG)`. Both Failure-Mode bullets observe
//     this controller: (a) Container.resolveCfg is never called for the
//     undeclared token, (b) the error message names the calling class.

class UndeclaredCallController extends ControllerBase {
  public static override deps = [];
  public static override state = [];
  public static override config = [DbConfig] as const;

  @Get("")
  public async show() {
    const _ = (this as unknown as { config: (t: unknown) => unknown; }).config(HOST_CONFIG);
    return this.ok({ unreachable: true });
  }
}

// Cross-Feature — fixtures.
//   - GhostReaderController: declares `static config = [GhostConfig]` and
//     surfaces the resolved section so the test can observe that a section
//     whose data is absent comes back as the empty object {} produced by the
//     schema parse — proof that Container.resolveCfg does not throw on a
//     missing key.

class GhostReaderController extends ControllerBase {
  public static override deps = [];
  public static override state = [];
  public static override config = [GhostConfig] as const;

  @Get("")
  public async show() {
    const cfg = (this as unknown as { config: (t: unknown) => unknown; }).config(
      GhostConfig,
    ) as Record<string, string | undefined>;
    // The schema parses {} -> {}, so the section keys are absent. Asking for
    // a non-existent property surfaces the "undefined for a missing key"
    // behavior of Container.resolveCfg (it returns whatever the resolved
    // config object had, no throw).
    return this.ok({
      sectionKeys: Object.keys(cfg),
      missingProperty: cfg["doesNotExist"] === undefined,
    });
  }
}

// Shared flare.json + shared host. Every primary / failure / cross-feature
// test runs against this app. Edge-case scenarios that need their own routes
// build their own host inside the describe block.

const SHARED_FLARE_JSON: JsonObject = {
  host: { env: "test", port: 0 },
  log: { level: "fatal", format: "json" },
  db: { url: "postgres://example/db", password: "s3cret" },
  // GhostConfig section deliberately absent from flare.json so the resolved
  // section is the empty `{}` auto-filled by #compileConfig — exercises the
  // "Container does not throw on a missing key" branch in Cross-Feature.
};

let lastConfigError: Error | null = null;

function buildSharedHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(nodeWith(SHARED_FLARE_JSON));

  host.cfg(DbConfig);
  host.cfg(GhostConfig);

  host.singleton(OnStartConfigService);

  host.http.controller("/undeclared-host", UndeclaredHostController);
  host.http.controller("/undeclared-call", UndeclaredCallController);
  host.http.controller("/ghost", GhostReaderController);

  // Captures the framework's developer-facing error so we can assert the
  // exact message shape reached the developer's error surface and that the
  // calling class name (not "FlareBase") appears in it.
  host.http.error((err) => {
    if (err.message.includes("called config(")) {
      lastConfigError = err;
    }
  });

  return host;
}

let app: TestAppHandle;
let sharedHost: ReturnType<typeof buildSharedHost>;

beforeAll(async () => {
  sharedHost = buildSharedHost();
  app = await sharedHost.build().test();
});

afterAll(async () => {
  await app.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Primary Behavior", () => {
  it("a service declaring `static config = [DbConfig]` can call `this.config(DbConfig)` from onStart and receive the resolved config object", () => {
    // OnStartConfigService is registered as a singleton, so its onStart hook
    // ran during host.build().test() — before any request was issued. The
    // captured value proves the resolved config was available at that point
    // AND that the guardrail accepted the declared token.
    const svc = sharedHost.singletonServices.get(OnStartConfigService) as
      | OnStartConfigService
      | undefined;
    expect(svc).toBeDefined();
    expect(svc!.capturedOnStart).toEqual({
      url: "postgres://example/db",
      password: "s3cret",
    });
  });

  it("a service declaring `static config = [DbConfig]` that calls `this.config(HOST_CONFIG)` throws with the exact spec message shape", async () => {
    lastConfigError = null;
    const res = await app.fetch("GET /undeclared-host");
    // The throw propagates to the default pipeline and surfaces as 500. The
    // inline error handler captured the original framework message, which
    // is the developer-facing contract.
    expect(res.status).toBe(500);
    expect(lastConfigError).not.toBeNull();
    expect(lastConfigError!.message).toBe(
      `[flare] UndeclaredHostController called config() with token "${HOST_CONFIG.key}" but "${HOST_CONFIG.key}" is not declared in UndeclaredHostController.config. Add it to the static config array.`,
    );
  });
});

describe("Edge Cases", () => {
  // Edge-case scenarios live on their own host because each scenario needs
  // its own controller route and they would otherwise pollute the shared
  // host's URL space and error-handler captures.
  let edgeApp: TestAppHandle;
  let edgeError: Error | null = null;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(nodeWith(SHARED_FLARE_JSON));
    host.cfg(DbConfig);

    host.http.controller("/empty-config", EmptyConfigController);
    host.http.controller("/child-inherits", ChildInheritsConfig);
    host.http.controller("/flare-base", FlareBaseProbeController);

    host.http.error((err) => {
      if (err.message.includes("called config(")) {
        edgeError = err;
      }
    });

    edgeApp = await host.build().test();
  });

  afterAll(async () => {
    await edgeApp.stop();
  });

  it("`static config = []` rejects every config() call (mirrors `static deps = []`)", async () => {
    edgeError = null;
    const res = await edgeApp.fetch("GET /empty-config");
    expect(res.status).toBe(500);
    expect(edgeError).not.toBeNull();
    expect(edgeError!.message).toBe(
      `[flare] EmptyConfigController called config() with token "${DbConfig.key}" but "${DbConfig.key}" is not declared in EmptyConfigController.config. Add it to the static config array.`,
    );
  });

  it("a subclass `B extends A` that does not redeclare inherits `A.config`", async () => {
    edgeError = null;
    // ChildInheritsConfig has no own `static config`. The lookup
    // `(this.constructor as typeof FlareBase).config` walks the prototype
    // chain and finds ParentDeclaresConfig.config = [DbConfig], so the
    // call must succeed.
    const res = await edgeApp.fetch("GET /child-inherits");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; };
    expect(body.url).toBe("postgres://example/db");
    expect(edgeError).toBeNull();
  });

  it("a class extending FlareBase (not FlareService) that uses config() inside a controller method works the same way — validation is on FlareBase, not lifecycle-specific", async () => {
    edgeError = null;
    // Good path: FlareBaseProbe declares static config = [DbConfig] and
    // the controller method constructs an instance with the live request
    // container, then calls probe.readGood(). The guardrail accepts it.
    const ok = await edgeApp.fetch("GET /flare-base/good");
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { url: string; };
    expect(okBody.url).toBe("postgres://example/db");
    expect(edgeError).toBeNull();

    // Bad path: same FlareBaseProbe class calls config(HOST_CONFIG). The
    // throw originates on a FlareBase subclass (no FlareService lifecycle),
    // proving validation lives on FlareBase itself.
    const bad = await edgeApp.fetch("GET /flare-base/bad");
    expect(bad.status).toBe(500);
    expect(edgeError).not.toBeNull();
    expect(edgeError!.message).toBe(
      `[flare] FlareBaseProbe called config() with token "${HOST_CONFIG.key}" but "${HOST_CONFIG.key}" is not declared in FlareBaseProbe.config. Add it to the static config array.`,
    );
  });
});

describe("Failure Modes", () => {
  it("when validation fails, Container.resolveCfg is never called (verified by spy)", async () => {
    lastConfigError = null;
    // Install the spy AFTER the host has built (so the build-time use of
    // resolveCfg by onStart is not counted) and BEFORE the request that
    // triggers the guardrail. A successful guardrail fire must short-circuit
    // FlareBase.config() before ever invoking container.resolveCfg.
    const spy = vi.spyOn(Container.prototype, "resolveCfg");

    const res = await app.fetch("GET /undeclared-call");
    expect(res.status).toBe(500);
    expect(lastConfigError).not.toBeNull();
    // The throw is the developer-facing contract; verify it before the spy
    // check so a failed assertion here surfaces the underlying error message.
    expect(lastConfigError!.message).toContain(
      `called config() with token "${HOST_CONFIG.key}"`,
    );
    // The spy was installed AFTER build, so any call observed here would
    // necessarily be from a per-request code path. Validation short-circuit
    // means the count stays at zero for the undeclared-token scenario.
    expect(spy).not.toHaveBeenCalled();
  });

  it("the thrown error names the calling class via `this.constructor.name`", async () => {
    lastConfigError = null;
    const res = await app.fetch("GET /undeclared-call");
    expect(res.status).toBe(500);
    expect(lastConfigError).not.toBeNull();
    // The message must contain the concrete subclass name and must NOT
    // contain "FlareBase" — `this.constructor.name` is the developer-
    // experience contract.
    expect(lastConfigError!.message).toContain("UndeclaredCallController");
    expect(lastConfigError!.message).not.toContain("FlareBase called config(");
    // Double-check by directly inspecting the runtime classname source: the
    // implementation uses `this.constructor.name`, so its value must equal
    // the controller class's own name even after going through the pipeline.
    expect(UndeclaredCallController.name).toBe("UndeclaredCallController");
    expect(FlareBase.name).toBe("FlareBase");
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with config) a token whose value is undefined in the resolved app config returns undefined from resolveCfg when validation passes — Container does not throw on a missing key", async () => {
    // GhostConfig is registered on the host (so UnregisteredTokenValidator
    // passes) with an empty descriptor (so MissingConfigKeyValidator has no
    // fields to require). flare.json omits the section, so #compileConfig
    // auto-creates it as `{}` and the schema parses it through unchanged.
    // The handler then calls `this.config(GhostConfig)` — the guardrail
    // accepts (token is in static config) and Container.resolveCfg returns
    // the resolved section WITHOUT throwing. Asking for a property the
    // section doesn't have surfaces the undefined-on-missing-key branch:
    // resolveCfg returned the raw value, no exception, and the absent key
    // reads back as undefined.
    const res = await app.fetch("GET /ghost");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sectionKeys: string[];
      missingProperty: boolean;
    };
    // The resolved section is the empty object {} produced by the parse,
    // proving the call did not throw even though no `ghost_section` data
    // was present anywhere upstream.
    expect(body.sectionKeys).toEqual([]);
    expect(body.missingProperty).toBe(true);
  });

  it("(with host / services/flare-service) this.config() called inside onStart for a singleton resolves correctly because the config object is built before start() runs", () => {
    // OnStartConfigService is registered as a SINGLETON. The host pipeline
    // does #compileConfig() before any singleton's onStart runs — so onStart
    // sees a fully-resolved config object. The captured value is asserted
    // here as the observable proof that ordering is correct.
    const svc = sharedHost.singletonServices.get(OnStartConfigService) as
      | OnStartConfigService
      | undefined;
    expect(svc).toBeDefined();
    // capturedOnStart is null until onStart runs; a non-null value proves
    // the hook fired AND the resolution succeeded.
    expect(svc!.capturedOnStart).not.toBeNull();
    expect(svc!.capturedOnStart).toEqual({
      url: "postgres://example/db",
      password: "s3cret",
    });
  });
});

// Used to keep TypeScript honest about typed ConfigToken imports even though
// the tests reference the tokens by value above. Anchoring it here keeps the
// import statement stable across `tsc --noEmit` runs.
const _typedTokenAnchor: ConfigToken<{ url: string; password: string; }> = DbConfig;
void _typedTokenAnchor;
