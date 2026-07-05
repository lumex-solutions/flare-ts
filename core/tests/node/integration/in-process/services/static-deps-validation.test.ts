/**
 * In-process integration tests for static deps declaration validation on
 * FlareBase.inject(). Exercises guardrails before container.resolveDep under
 * the Node in-process harness. FLARE_MODE must be set before imports so the
 * node adapter's env binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Container } from "../../../../../src/lib/services/container.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { Get } from "../../../../../src/decorators.js";
import { FlareHost, ControllerBase, FlareBase, FlareService, Logger } from "../../../../../src/index.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

let serviceCounter = 0;

class UserService extends FlareService {
  public static override deps = [];
  public readonly id = `UserService#${++serviceCounter}`;
}

class OtherService extends FlareService {
  public static override deps = [];
}

/** Returns the resolved UserService id in the response body. */
class DeclaredOnlyController extends ControllerBase {
  public static override deps = [UserService];
  public static override state = [];

  readonly #users = this.inject(UserService);

  @Get("")
  public async show() {
    return this.ok({ id: this.#users.id });
  }
}

/** Calls inject(Logger) despite Logger not being in static deps. */
class UndeclaredLoggerController extends ControllerBase {
  public static override deps = [UserService];
  public static override state = [];

  @Get("")
  public async show() {
    // Cast through `as never` to satisfy the typed Injected projection; the
    // point of this test is the runtime validation, not the type system.
    const _ = (this as unknown as { inject: (t: unknown) => unknown; }).inject(Logger);
    return this.ok({ unreachable: true });
  }
}

let flakyConstructions = 0;

class FlakyToken extends FlareService {
  public static override deps = [];
  constructor(container: Container) {
    super(container);
    flakyConstructions++;
  }
}

class FailBeforeResolveController extends ControllerBase {
  public static override deps = [UserService];
  public static override state = [];

  @Get("")
  public async show() {
    // FlakyToken is registered as scoped on the host. If the validation passes
    // before container.resolveDep is consulted, FlakyToken's constructor would
    // run, bumping flakyConstructions. The test asserts it does not.
    const _ = (this as unknown as { inject: (t: unknown) => unknown; }).inject(FlakyToken);
    return this.ok({ unreachable: true });
  }
}

class ParentWithDeps extends ControllerBase {
  public static override deps = [UserService];
  public static override state = [];

  @Get("")
  public async show() {
    // Inherited static deps: Child must still see [UserService].
    const u = this.inject(UserService);
    return this.ok({ id: u.id });
  }
}

class ChildInheritsDeps extends ParentWithDeps {
  // Intentionally NO `static override deps`. Inherits from ParentWithDeps.
}

class ChildOverridesDeps extends ParentWithDeps {
  // Override with a different non-empty array. UserService is excluded from
  // Child's deps, so `this.inject(UserService)` must throw.
  // `as never` bypasses the static-extends check: ParentWithDeps.deps is
  // inferred as `(typeof UserService)[]`, so overriding with `[OtherService]`
  // would be rejected without the cast. The test exercises the runtime guard.
  public static override deps = [OtherService] as never;
  public static override state = [];
}

class EmptyDepsController extends ControllerBase {
  public static override deps = [];
  public static override state = [];

  @Get("")
  public async show() {
    // Any inject call must throw because static deps is the empty array.
    const _ = (this as unknown as { inject: (t: unknown) => unknown; }).inject(UserService);
    return this.ok({ unreachable: true });
  }
}

/** FlareBase probe with no static deps; exercised via UndefinedDepsController. */
class UndefinedDepsProbe extends FlareBase {
  // No `static deps` declaration at all. The lookup `(this.constructor as
  // typeof FlareService).deps` returns `undefined` and the validation in
  // FlareBase.inject() must throw.
  public attempt(): unknown {
    return (this as unknown as { inject: (t: unknown) => unknown; }).inject(UserService);
  }
}

class UndefinedDepsController extends ControllerBase {
  // Declared to satisfy the build-time service-registration validator.
  public static override deps = [UserService];
  public static override state = [];

  @Get("")
  public async show() {
    const probe = new UndefinedDepsProbe(this.container);
    probe.attempt();
    return this.ok({ unreachable: true });
  }
}

let sharedSingletonCounter = 0;
class SharedSingleton extends FlareService {
  public static override deps = [];
  public readonly id = `Singleton#${++sharedSingletonCounter}`;
}

let sharedScopedCounter = 0;
class SharedScoped extends FlareService {
  public static override deps = [];
  public readonly id = `Scoped#${++sharedScopedCounter}`;
}

class SemanticsController extends ControllerBase {
  public static override deps = [SharedSingleton, SharedScoped];
  public static override state = [];

  readonly #s = this.inject(SharedSingleton);
  readonly #p = this.inject(SharedScoped);

  @Get("")
  public async show() {
    return this.ok({ singleton: this.#s.id, scoped: this.#p.id });
  }
}

/** Builds the shared host for primary, failure, and cross-feature cases; edge cases use their own host. */
function buildSharedHost() {
  process.env["FLARE_MODE"] = "test";

  const host = new FlareHost(nodeAdapter({}));

  host.scoped(UserService);
  host.scoped(OtherService);
  host.scoped(FlakyToken);
  host.singleton(SharedSingleton);
  host.scoped(SharedScoped);

  host.http.controller("/declared", DeclaredOnlyController);
  host.http.controller("/undeclared-logger", UndeclaredLoggerController);
  host.http.controller("/fail-before-resolve", FailBeforeResolveController);
  host.http.controller("/semantics", SemanticsController);

  // Capture the framework's developer-facing error so we can assert the exact
  // message shape reached the developer's error surface and that the calling
  // class name (not "FlareBase") appears in it.
  host.http.error((err) => {
    if (err.message.includes("called inject(")) {
      lastInjectError = err;
    }
  });

  return host;
}

let lastInjectError: Error | null = null;

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildSharedHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("a controller that declares `static deps = [UserService]` can `this.inject(UserService)` and receive the resolved service", async () => {
    lastInjectError = null;
    const res = await app.fetch("GET /declared");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; };
    // The id stamp is produced by the registered factory; receiving it proves
    // the value came from the container, not a stale or fresh `new` call.
    expect(body.id.startsWith("UserService#")).toBe(true);
    expect(lastInjectError).toBeNull();
  });

  it("a controller that declares `static deps = [UserService]` and calls `this.inject(Logger)` throws with the exact message shape", async () => {
    lastInjectError = null;
    const res = await app.fetch("GET /undeclared-logger");
    // The throw propagates through dispatchErrorHandlers and the default
    // handler converts it to 500. The inline error handler captured the
    // original framework message, which is the developer-facing contract.
    expect(res.status).toBe(500);
    expect(lastInjectError).not.toBeNull();
    expect(lastInjectError!.message).toBe(
      `[flare] UndeclaredLoggerController called inject("Logger") but "Logger" is not declared in UndeclaredLoggerController.deps. Add it to the static deps array.`,
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
    const host = new FlareHost(nodeAdapter({}));
    host.scoped(UserService);
    host.scoped(OtherService);

    host.http.controller("/child-inherits", ChildInheritsDeps);
    host.http.controller("/child-overrides", ChildOverridesDeps);
    host.http.controller("/empty-deps", EmptyDepsController);
    host.http.controller("/undefined-deps", UndefinedDepsController);

    host.http.error((err) => {
      if (err.message.includes("called inject(")) {
        edgeError = err;
      }
    });

    edgeApp = await host.build().test();
  });

  afterAll(async () => {
    await edgeApp.stop();
  });

  it("a subclass B extends A where A.deps = [UserService] and B does not redeclare deps can inject UserService (class-side inheritance)", async () => {
    edgeError = null;
    const res = await edgeApp.fetch("GET /child-inherits");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; };
    expect(body.id.startsWith("UserService#")).toBe(true);
    expect(edgeError).toBeNull();
  });

  it("a subclass B extends A where both A.deps and B.deps exist uses B.deps (override semantics)", async () => {
    edgeError = null;
    // ChildOverridesDeps redeclares `static deps = [OtherService]`. The
    // inherited handler still calls `this.inject(UserService)`, but
    // UserService is not declared on the child, so the validation
    // must fire and name the child class.
    const res = await edgeApp.fetch("GET /child-overrides");
    expect(res.status).toBe(500);
    expect(edgeError).not.toBeNull();
    expect(edgeError!.message).toBe(
      `[flare] ChildOverridesDeps called inject("UserService") but "UserService" is not declared in ChildOverridesDeps.deps. Add it to the static deps array.`,
    );
  });

  it("a class with `static deps = []` rejects every inject() call", async () => {
    edgeError = null;
    const res = await edgeApp.fetch("GET /empty-deps");
    expect(res.status).toBe(500);
    expect(edgeError).not.toBeNull();
    expect(edgeError!.message).toBe(
      `[flare] EmptyDepsController called inject("UserService") but "UserService" is not declared in EmptyDepsController.deps. Add it to the static deps array.`,
    );
  });

  it("a class with no `static deps` declaration at all (undefined) rejects every inject() call", async () => {
    edgeError = null;
    const res = await edgeApp.fetch("GET /undefined-deps");
    expect(res.status).toBe(500);
    expect(edgeError).not.toBeNull();
    // The throw originates inside UndefinedDepsProbe (a FlareBase subclass
    // with no `static deps` line at all), so the message names that probe,
    // proving that the lookup walks `this.constructor` of the calling
    // instance, not the controller that invoked it.
    expect(edgeError!.message).toBe(
      `[flare] UndefinedDepsProbe called inject("UserService") but "UserService" is not declared in UndefinedDepsProbe.deps. Add it to the static deps array.`,
    );
  });
});

describe("Failure Modes", () => {
  it("the validation error is thrown before container.resolveDep is invoked; failing fast prevents wasted resolution work", async () => {
    lastInjectError = null;
    const before = flakyConstructions;
    const res = await app.fetch("GET /fail-before-resolve");
    expect(res.status).toBe(500);
    expect(lastInjectError).not.toBeNull();
    expect(lastInjectError!.message).toBe(
      `[flare] FailBeforeResolveController called inject("FlakyToken") but "FlakyToken" is not declared in FailBeforeResolveController.deps. Add it to the static deps array.`,
    );
    // The container would have constructed FlakyToken if the validation had
    // deferred to resolveDep. The counter not budging is the observable
    // proof that the throw fired before any resolution work occurred.
    expect(flakyConstructions).toBe(before);
  });

  it("the error names the calling class (this.constructor.name), not FlareBase", async () => {
    lastInjectError = null;
    const res = await app.fetch("GET /undeclared-logger");
    expect(res.status).toBe(500);
    expect(lastInjectError).not.toBeNull();
    // The message must contain the concrete subclass name and must NOT
    // contain "FlareBase"; that is the developer-experience contract.
    expect(lastInjectError!.message).toContain("UndeclaredLoggerController");
    expect(lastInjectError!.message).not.toContain("FlareBase");
    // Double-check by directly inspecting the runtime classname source: the
    // implementation uses `this.constructor.name`, so its value must equal
    // the controller class's own name even after going through the pipeline.
    expect(UndeclaredLoggerController.name).toBe("UndeclaredLoggerController");
    expect(FlareBase.name).toBe("FlareBase");
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with services/container) when validation passes, the resolved value comes from container.resolveDep and reflects singleton/scoped semantics correctly", async () => {
    const r1 = await app.fetch("GET /semantics");
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as { singleton: string; scoped: string; };

    const r2 = await app.fetch("GET /semantics");
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { singleton: string; scoped: string; };

    // Singleton: same id across two requests proves container returned the
    // pre-built singleton from the singleton map both times.
    expect(body1.singleton).toBe(body2.singleton);
    expect(body1.singleton.startsWith("Singleton#")).toBe(true);

    // Scoped: distinct id per request proves the container ran the
    // registered factory in each request's per-request cache.
    expect(body1.scoped).not.toBe(body2.scoped);
    expect(body1.scoped.startsWith("Scoped#")).toBe(true);
    expect(body2.scoped.startsWith("Scoped#")).toBe(true);
  });
});
