import { describe, it, expect } from "vitest";
import { splitPath } from "../../../../../src/lib/arcs/http/routing/flare-router.js";

describe("splitPath", () => {
  it("`/` → `[]`", () => {
    expect(splitPath("/")).toEqual([]);
  });

  it('`/a` → `["a"]`', () => {
    expect(splitPath("/a")).toEqual(["a"]);
  });

  it('`/a/b/c` → `["a","b","c"]`', () => {
    expect(splitPath("/a/b/c")).toEqual(["a", "b", "c"]);
  });
});
