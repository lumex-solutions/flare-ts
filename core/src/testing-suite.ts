/**
 * `@flare-ts/core/testing/suite`: the prebuilt test suite, which registers Flare's own checks of an app as
 * vitest tests. Importing it needs vitest; `@flare-ts/core/testing` does not.
 *
 * @packageDocumentation
 */
export { flareSuite } from "./lib/testing/suite/register.js";
export type { FlareSuiteOptions, RoutePolicy, SuiteCheck } from "./lib/testing/suite/types.js";
