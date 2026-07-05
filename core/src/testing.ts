/** `@flare-ts/core/testing`: the portable testing surface (the in-process `.test()` harness, build inspection, and DI mocks). */
export type { AppTestOptions } from "./lib/host/flare-app.js";
export { FlareTestError } from "./lib/testing/error.js";
export { inspectBuild } from "./lib/testing/inspect-build.js";
export type {
  AppInspectSnapshot,
  FlareBuildSnapshot,
  HostInspectSnapshot,
  HttpArcInspectSnapshot,
  PipelineInspectSnapshot,
  RouterInspectSnapshot,
} from "./lib/testing/inspect-build.js";
export { mockContainer, mockContext } from "./lib/testing/mock.js";
export type { MockContainer } from "./lib/testing/mock.js";
export { TestAppHandle } from "./lib/testing/test.js";
export type { FlareTestReq, FlareTestRequestInput } from "./lib/testing/types/flare-test-req.js";
export type { MockContextOpts } from "./lib/testing/types/mock-context-opts.js";
