/**
 * Compile-time tests for the group builder: `host.http.group(prefix, fn)` registers the group when
 * `fn` returns, so the builder is synchronous and returns nothing. The file passing `tsc` IS the
 * assertion (the `@ts-expect-error` lines fail the build if they stop erroring); the single runtime
 * `it` only anchors it as a vitest file. See HttpGroupFn in composition/group.ts.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

const host = testHost();

host.http.group("/sync", (g) => {
  g.get("/a", () => new FlareResponse(200));
});

// @ts-expect-error - an async builder would register routes after the group is finalized.
host.http.group("/async", async (g) => {
  g.get("/a", () => new FlareResponse(200));
});

// @ts-expect-error - the builder returns nothing; host.http.group registers the group itself.
host.http.group("/returns", (g) => g.get("/a", () => new FlareResponse(200)));

describe("group builder types", () => {
  it("compiles: a group builder is synchronous and returns nothing", () => {
    expect(true).toBe(true);
  });
});
