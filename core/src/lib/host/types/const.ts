/** @internal */
export const SET_HOST_STATE: unique symbol = Symbol("SET_HOST_STATE");

/**
 * @internal
 * Driven by `FlareTestApp.test()` to apply replacement registrations, re-run the
 * service validator suite against the post-replacement graph, and compile
 * singletons. Encapsulates the host-private state mutation so `FlareTestApp`
 * does not need direct access to internal fields.
 */
export const COMPILE_FOR_TEST: unique symbol = Symbol("COMPILE_FOR_TEST");

/**
 * @internal
 * Driven by `TestAppHandle.reset()`. Restores the original registration arrays
 * snapshotted at first compile, clears compiled singletons, and resets the
 * compiled flag so a fresh `[COMPILE_FOR_TEST]` can run with a new replacement set.
 */
export const RESET_FOR_TEST: unique symbol = Symbol("RESET_FOR_TEST");

/** @internal */
export const UNSAFE_CONFIG_ENV_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * @internal
 * Test-only snapshot of host-private compile state for {@link inspectBuild}.
 */
export const INSPECT_HOST: unique symbol = Symbol("INSPECT_HOST");

/**
 * @internal
 * Registers a framework-provided service contributed by a runtime adapter's `setup`, via a custom
 * factory. The token participates in normal build-time dependency validation; its instance is seeded
 * by the runtime/terminal rather than built from the default `new Service(container)` factory.
 * Symbol-keyed so it stays off the public surface.
 */
export const PROVIDE_SERVICE: unique symbol = Symbol("PROVIDE_SERVICE");

/**
 * @internal
 * Re-runs the dependency/HTTP/config validation suite against the current graph. A terminal calls
 * this after registering its framework services post-`build()`, so the now-complete graph is checked
 * (and injecting a service only another terminal provides fails clearly).
 */
export const REVALIDATE: unique symbol = Symbol("REVALIDATE");

/**
 * @internal
 * Builds a fresh singleton map seeded with the given service factories (on top of the framework
 * prebuilts, e.g. Logger), then compiles the user singletons into it. Lets a terminal produce a
 * singleton graph scoped to one exported instance (e.g. a Durable Object) rather than the shared one.
 */
export const COMPILE_INSTANCE_SINGLETONS: unique symbol = Symbol("COMPILE_INSTANCE_SINGLETONS");

/**
 * @internal
 * Builds a per-context Container from framework seed factories plus the user scoped registry
 * resolved lazily. Used by the CF Worker (per request) and DO (per instance).
 */
export const COMPILE_INSTANCE_CONTAINER: unique symbol = Symbol("COMPILE_INSTANCE_CONTAINER");

/**
 * @internal
 * Registers a build hook run once during `build()` before compilation. A runtime adapter's `setup`
 * uses it to alter the build via the mutable `FlareBuildContext` (e.g. defer singleton compilation),
 * keeping runtime-specific behavior on the adapter rather than as runtime branches in the host.
 */
export const REGISTER_BUILD_HOOK: unique symbol = Symbol("REGISTER_BUILD_HOOK");
