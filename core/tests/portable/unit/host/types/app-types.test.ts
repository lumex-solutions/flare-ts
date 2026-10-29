/**
 * Compile-time claims for FlareApp: typed with an adapter it is that runtime's app; bare, it is the
 * face every runtime's app shares. The file passing `tsc` IS the assertion (the `@ts-expect-error`
 * lines fail the build if they stop erroring); the single runtime `it` only anchors it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import type { FlareApp } from "../../../../../src/index.js";
import type { FlareAppNode } from "../../../../../src/lib/host/runtime/node/flare-app-node.js";
import type { node } from "../../../../../src/lib/host/runtime/node/node.js";
import type { TestAppHandle } from "../../../../../src/testing.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _NodeApp = Expect<Equal<FlareApp<typeof node>, FlareAppNode>>;
type _NodeAppIsAnApp = Expect<FlareAppNode extends FlareApp ? true : false>;
type _Test = Expect<Equal<ReturnType<FlareApp["test"]>, Promise<TestAppHandle>>>;

// @ts-expect-error - the shared face carries no runtime entrypoint.
type _NoRun = FlareApp["run"];

// @ts-expect-error - nor the lifecycle the runtime drives.
type _NoStart = FlareApp["start"];

describe("FlareApp types", () => {
  it("compiles: FlareApp<adapter> is the runtime's app, bare FlareApp is the shared face", () => {
    expect(true).toBe(true);
  });
});
