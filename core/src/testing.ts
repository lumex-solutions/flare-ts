/**
 * `@flare-ts/core/testing`: the portable testing surface, which works with any test runner. The
 * vitest-based prebuilt suite is on `@flare-ts/core/testing/suite`.
 *
 * @packageDocumentation
 */
export type { AppTestOptions } from "./lib/host/flare-app-base.js";
export { expectError } from "./lib/testing/expect-error.js";
export type { FlareErrorBody } from "./lib/testing/expect-error.js";
export { FlareTestError } from "./lib/testing/flare-test-error.js";
export { inspectBuild } from "./lib/testing/inspect-build.js";
export { mockContainer, mockContext } from "./lib/testing/mock.js";
export type { MockContainer } from "./lib/testing/mock.js";
export { TestAppHandle } from "./lib/testing/test-app-handle.js";
export type { TestRequestInit } from "./lib/testing/types/flare-test-req.js";
export type {
  AppInspectSnapshot,
  BuildSnapshot,
  HostInspectSnapshot,
  HttpArcInspectSnapshot,
  PipelineInspectSnapshot,
  RouterInspectSnapshot,
} from "./lib/testing/types/inspect-build.js";
export type { MockContextOpts } from "./lib/testing/types/mock-context-opts.js";
