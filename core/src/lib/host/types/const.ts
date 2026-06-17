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
