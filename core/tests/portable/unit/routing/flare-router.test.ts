/**
 * Unit tests for {@link FlareRouter} path splitting, route scoring, and trie matching.
 */
import { describe, expect, it } from "vitest";
import { buildFlareRouter, scoreRoute, splitPath } from "../../../../src/lib/routing/flare-router.js";

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

describe("scoreRoute", () => {
  it("scores literal=2, param=1, wildcard=0", () => {
    expect(scoreRoute("/")).toBe(0);
    expect(scoreRoute("/a")).toBe(2);
    expect(scoreRoute("/a/b")).toBe(4);
    expect(scoreRoute("/a/:id")).toBe(3);
    expect(scoreRoute("/:id")).toBe(1);
    expect(scoreRoute("/files/*rest")).toBe(2); // literal 2 + wildcard 0
  });

  it("ranks a literal route ahead of a param route at the same depth", () => {
    expect(scoreRoute("/chat/admin")).toBeGreaterThan(scoreRoute("/chat/:room"));
  });
});

describe("buildFlareRouter", () => {
  it('empty routes: throws "no routes provided"', () => {
    expect(() => buildFlareRouter([], 0)).toThrow("FlareRouter: no routes provided");
  });

  it('more than MAX_ROUTES (1025): throws "exceeds maximum of 1024"', () => {
    const routes = Array.from({ length: 1025 }, (_, i) => `/r${i}`);
    expect(() => buildFlareRouter(routes, 1)).toThrow(
      "FlareRouter: 1025 routes exceeds maximum of 1024",
    );
  });

  it("static-only routes: exact match via `staticMap` returns the index", () => {
    const routes = ["/users", "/posts", "/admin/dashboard"];
    const router = buildFlareRouter(routes, 2);
    expect(router.match("/users")).toBe(0);
    expect(router.match("/posts")).toBe(1);
    expect(router.match("/admin/dashboard")).toBe(2);
  });

  it('param route: matches "/users/123" to "/users/:id"', () => {
    const routes = ["/users/:id"];
    const router = buildFlareRouter(routes, 2);
    expect(router.match("/users/123")).toBe(0);
  });

  it('wildcard route: matches arbitrarily deep paths to "/assets/*path"', () => {
    const routes = ["/assets/*path"];
    const router = buildFlareRouter(routes, 5);
    expect(router.match("/assets/a")).toBe(0);
    expect(router.match("/assets/a/b")).toBe(0);
    expect(router.match("/assets/a/b/c/d")).toBe(0);
  });

  it("same-depth literal+param: literal wins over param at the same index (caller ensures pre-sort)", () => {
    // Caller pre-sorts most-specific first: literal segment (score 2) before
    // param segment (score 1). Lowest set bit wins == lowest index wins.
    const routes = ["/users/me", "/users/:id"];
    const router = buildFlareRouter(routes, 2);
    expect(router.match("/users/me")).toBe(0);
    expect(router.match("/users/123")).toBe(1);
  });

  it("no match: returns -1", () => {
    const routes = ["/users/:id"];
    const router = buildFlareRouter(routes, 2);
    expect(router.match("/posts/123")).toBe(-1);
  });

  it("path exceeds maxDepth+2: returns -1", () => {
    const routes = ["/a"];
    const router = buildFlareRouter(routes, 1);
    // maxDepth = 1, so depth guard rejects paths whose segment count exceeds
    // maxDepth + 2 = 3.
    expect(router.match("/a/b/c/d")).toBe(-1);
  });

  it("segStart/segEnd are populated for successful matches", () => {
    const routes = ["/users/:id/posts"];
    const router = buildFlareRouter(routes, 3);
    const idx = router.match("/users/42/posts");
    expect(idx).toBe(0);
    // Path: "/users/42/posts"
    //  index: 0123456789012345
    // segments: "users" (1..6), "42" (7..9), "posts" (10..15)
    expect(router.segStart[0]).toBe(1);
    expect(router.segEnd[0]).toBe(6);
    expect(router.segStart[1]).toBe(7);
    expect(router.segEnd[1]).toBe(9);
    expect(router.segStart[2]).toBe(10);
    expect(router.segEnd[2]).toBe(15);
  });
});

describe("Internal helpers (exercised through buildFlareRouter)", () => {
  it("isWildcardRoute: true when last segment starts with `*`", () => {
    // Exercised by wildcard routes matching deeper paths than their prefix:
    // only an isWildcardRoute === true route is alive at depths > prefixLen.
    const routes = ["/files/*rest"];
    const router = buildFlareRouter(routes, 4);
    expect(router.match("/files/a/b/c")).toBe(0);
    // A non-wildcard route of the same prefix would not be alive at deeper
    // depths, so the contrast is observable:
    const nonWild = buildFlareRouter(["/files/list"], 4);
    expect(nonWild.match("/files/list/extra")).toBe(-1);
  });

  it("prefixLength: routeLen - 1 for wildcard routes; routeLen otherwise", () => {
    // For a wildcard, prefixLength excludes the trailing wildcard segment, so
    // the literal "/api" prefix still discriminates at segment 0, and a path
    // that doesn't match the literal prefix returns -1 even though the route
    // has a wildcard.
    const wild = buildFlareRouter(["/api/*rest"], 3);
    expect(wild.match("/api/a/b")).toBe(0);
    expect(wild.match("/other/a/b")).toBe(-1);

    // For a non-wildcard, prefixLength === parts.length, so every segment is
    // discriminating and a path with extra segments doesn't match.
    const plain = buildFlareRouter(["/api/list"], 3);
    expect(plain.match("/api/list")).toBe(0);
    expect(plain.match("/api/list/extra")).toBe(-1);
  });

  it("countTrailingZeros: returns 32 for 0; correct value for powers of two", () => {
    // The match function returns the index of the lowest set bit (== highest
    // priority route). With 33 routes the winner crosses a word boundary,
    // exercising ctz across multiple words. We observe ctz indirectly via the
    // returned route index: an exact match on the i-th route returns i, which
    // is only correct if ctz of a single-bit mask returns the bit position.
    const routes = Array.from({ length: 33 }, (_, i) => `/r${i}`);
    const router = buildFlareRouter(routes, 1);
    expect(router.match("/r0")).toBe(0);
    expect(router.match("/r1")).toBe(1);
    expect(router.match("/r31")).toBe(31);
    expect(router.match("/r32")).toBe(32);
    // No match collapses every word to 0; ctz of 0 == 32 means the function
    // must return -1 rather than 32 from the final fallback.
    expect(router.match("/nope")).toBe(-1);
  });
});

describe("discriminator collisions (needsLit / partial split / fallback)", () => {
  it("same-length literals with shared prefix: char probes alone are insufficient", () => {
    // Forces needsLit on unprobed tail bytes. Without full-literal compare,
    // "/ab99" could false-positive against "/ab12" when early probes agree.
    const routes = ["/ab12", "/ab34"];
    const router = buildFlareRouter(routes, 1);
    expect(router.match("/ab12")).toBe(0);
    expect(router.match("/ab34")).toBe(1);
    expect(router.match("/ab99")).toBe(-1);
    expect(router.match("/ab1")).toBe(-1);
  });

  it("three same-length literals: partial split then fallback discriminators", () => {
    // "/file", "/fill", "/fizz" share length and early chars; the resolver
    // must partial-split or fall back to full-literal compare for each.
    const routes = ["/file", "/fill", "/fizz"];
    const router = buildFlareRouter(routes, 1);
    expect(router.match("/file")).toBe(0);
    expect(router.match("/fill")).toBe(1);
    expect(router.match("/fizz")).toBe(2);
    expect(router.match("/fizzx")).toBe(-1);
    expect(router.match("/filo")).toBe(-1);
    expect(router.match("/fail")).toBe(-1);
  });

  it("literal vs param: probe-agreeing input that fails full literal falls through to param", () => {
    // Caller pre-sorts literal (score 4) before param (score 3). Segment "mx"
    // shares the first probe char with "me" but must not win the literal route;
    // the param route at the same depth should match instead.
    const routes = ["/users/me", "/users/:id"];
    const router = buildFlareRouter(routes, 2);
    expect(router.match("/users/me")).toBe(0);
    expect(router.match("/users/123")).toBe(1);
    expect(router.match("/users/mx")).toBe(1);
    expect(router.match("/users/mz")).toBe(1);
  });

  it("N > 32: competing same-length literals in the second bitmask word", () => {
    // Extends the 33-route ctz case: filler routes occupy word 0 and bit 0 of
    // word 1; collision literals at indices 33–34 compete at the same depth
    // inside word 1, exercising ctz and needsLit across the word boundary.
    const routes = [
      ...Array.from({ length: 33 }, (_, i) => `/r${i}`),
      "/ab12",
      "/ab34",
    ];
    const router = buildFlareRouter(routes, 1);
    expect(router.match("/r0")).toBe(0);
    expect(router.match("/r32")).toBe(32);
    expect(router.match("/ab12")).toBe(33);
    expect(router.match("/ab34")).toBe(34);
    expect(router.match("/ab99")).toBe(-1);
    expect(router.match("/nope")).toBe(-1);
  });
});
