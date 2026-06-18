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
 * Resolved request extensions for the host's runtime, read by the app's per-request runner.
 * Symbol-keyed so this internal plumbing stays out of the package's public type surface.
 */
export const REQUEST_EXTENSIONS: unique symbol = Symbol("REQUEST_EXTENSIONS");

/**
 * @internal
 * Registers a framework-provided service (a custom-factory service contributed by a host
 * extension, e.g. the Cloudflare `DurableState`/`Bindings` wrappers). The token participates in
 * normal build-time dependency validation; its instance is seeded by the runtime, not built from
 * the default `new Service(container)` factory. Symbol-keyed so it stays off the public surface.
 */
export const PROVIDE_SERVICE: unique symbol = Symbol("PROVIDE_SERVICE");

/**
 * @internal
 * Builds a fresh per-instance singleton map for a {@link DurableHostRuntimeAdapter}: framework
 * prebuilts (Logger) plus the runtime services seeded by the exported instance's constructor
 * (`DurableState`/`Bindings`), then the user singletons compiled into it. Driven by the generated
 * Durable Object class so each instance gets its own singleton graph.
 */
export const COMPILE_INSTANCE_SINGLETONS: unique symbol = Symbol("COMPILE_INSTANCE_SINGLETONS");

/**
 * @internal
 * Registers a build hook run once during `build()` before compilation. Host extensions use it to
 * alter the build via the mutable `FlareBuildContext` (e.g. the `durable` extension defers
 * module-level singleton compilation) without the host branching on the runtime string.
 */
export const REGISTER_BUILD_HOOK: unique symbol = Symbol("REGISTER_BUILD_HOOK");
