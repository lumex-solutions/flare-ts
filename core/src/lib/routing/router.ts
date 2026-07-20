/**
 * @module router
 *
 * Bitset-based URL router for the Flare framework.
 *
 * Builds a compact bitset index over all registered routes at startup, then
 * matches incoming request paths in three tiers:
 *
 *   1. Static lookup: `staticMap.get(path)` for O(1) exact matches.
 *   2. Depth filter: `depthMask[depth]` eliminates routes with the wrong
 *      number of segments.
 *   3. Segment discriminators: per-segment character probes and literal
 *      comparisons narrow the candidate set via bitwise AND.
 *
 * The winner is the lowest set bit ({@link countTrailingZeros}), which
 * corresponds to the highest-priority route by construction. Routes must be
 * pre-sorted by specificity score before being passed in:
 *   `score = sum(literal=2, param=1, wildcard=0)` over segments.
 *
 * `W = ceil(N / 32)` is the number of 32-bit words needed to represent the
 * full route set. The generated {@link generateMatchFunction | match function}
 * bakes `W` as a closure constant, emitting width-specific straight-line code
 * the runtime can optimize similarly to hand-written specialized code.
 *
 * Supports up to {@link MAX_ROUTES} (1024) routes.
 */

/**
 * Compiled router returned by {@link buildRouter}.
 *
 * @internal
 */
export type Router = {
  /**
   * Returns the index of the best-matching route, or `-1` if none match.
   *
   * On a successful match (return value >= 0) the segment boundary arrays
   * {@link segStart} and {@link segEnd} are populated in-place and valid
   * until the next call to `match`. Callers must read them synchronously:
   * never await between `match` and consuming these arrays.
   */
  match(path: string): number;

  /**
   * Segment start offsets populated by the most recent successful {@link match} call.
   *
   * Index `i` holds the start offset (inclusive) of the i-th path segment in the matched path.
   */
  readonly segStart: Int16Array;

  /**
   * Segment end offsets populated by the most recent successful {@link match} call.
   *
   * Index `i` holds the end offset (exclusive) of the i-th path segment in the matched path.
   */
  readonly segEnd: Int16Array;

  /** Total number of routes compiled into this router. */
  readonly routeCount: number;

  /** Number of 32-bit words per bitmask row (`ceil(routeCount / 32)`). */
  readonly W: number;

  /** Maximum number of path segments across all compiled routes. */
  readonly maxDepth: number;
};

/** Maximum number of 32-bit words per bitmask row. */
const MAX_WORDS = 32;

/** Absolute route capacity (`MAX_WORDS * 32 = 1024`). */
const MAX_ROUTES = MAX_WORDS * 32;

/**
 * Single entry in the per-segment discriminator table.
 *
 * Each discriminator can test up to three character offsets (`c1`-`c3`) and an
 * optional full-literal comparison to narrow candidates for a given segment
 * position and length.
 */
type Discriminator = {
  /** Row index into the discriminator mask table. */
  entryIndex: number;

  /** Expected segment length (excluding slashes). */
  len: number;

  /** First character-probe offset, or `-1` if unused. */
  c1off: number;
  /** Expected char code at {@link c1off}. */
  c1val: number;

  /** Second character-probe offset, or `-1` if unused. */
  c2off: number;
  /** Expected char code at {@link c2off}. */
  c2val: number;

  /** Third character-probe offset, or `-1` if unused. */
  c3off: number;
  /** Expected char code at {@link c3off}. */
  c3val: number;

  /**
   * Full literal for fallback comparison.
   *
   * Empty string when character probes suffice.
   */
  lit: string;
};

/** Mutable counter threaded through the recursive discriminator builder to allocate mask-table rows. */
type IndexCounter = {
  idx: number;
};

/**
 * Splits an absolute path (`/a/b/c`) into segment strings (`["a", "b", "c"]`).
 *
 * Returns `[]` for `/`.
 *
 * @internal
 */
export function splitPath(path: string): string[] {
  return path.length <= 1 ? [] : path.slice(1).split("/");
}

/**
 * Scores a route pattern by specificity: the pre-sort key {@link buildRouter} requires (most specific first).
 *
 * A literal segment counts 2, a `:param` counts 1, and a `*wildcard` counts 0, so a
 * more literal route always sorts ahead of a more wildcard one. Shared by the HTTP and WebSocket arcs
 * so the ordering rule has a single implementation.
 *
 * @internal
 */
export function scoreRoute(path: string): number {
  let score = 0;
  for (const segment of splitPath(path)) {
    const c = segment.charCodeAt(0);
    if (c === 42) continue; // "*": wildcard, contributes 0
    score += c === 58 ? 1 : 2; // ":" param vs literal
  }
  return score;
}

/**
 * Compiles an ordered array of route patterns into a {@link Router}.
 *
 * Routes must be absolute paths (starting with `/`) and may contain:
 * - **Literal segments**: e.g. `/users/settings`
 * - **Parameter segments**: e.g. `/users/:id`
 * - **Wildcard suffix**: e.g. `/assets/*path`
 *
 * The array must be **pre-sorted by specificity** (most-specific first).
 * Bit position = array index = the value returned by {@link Router.match}.
 *
 * @param routes - Pre-sorted route patterns. Length must be in `[1, 1024]`.
 * @param maxDepth - Maximum segment count across all routes; the caller derives it by scanning every route's segments.
 * @returns A compiled router ready for path matching.
 * @throws If no routes are provided or the count exceeds {@link MAX_ROUTES}.
 * @internal
 */
export function buildRouter(routes: string[], maxDepth: number): Router {
  const N = routes.length;
  if (N === 0) throw new Error("Router: no routes provided");
  if (N > MAX_ROUTES) throw new Error(`Router: ${N} routes exceeds maximum of ${MAX_ROUTES}`);

  const W = Math.ceil(N / 32);

  // Bitmask tables
  // depthMask:    routes alive at a given segment depth
  // anyMask:      routes with a param / wildcard at a given segment position
  // literalMaps:  per-position map from literal to bitmask (consumed by discriminator builder)

  const depthMask = new Int32Array((maxDepth + 4) * W);
  const anyMask = new Int32Array((maxDepth + 4) * W);
  const literalMaps: Map<string, number[]>[] = Array.from({ length: maxDepth + 2 }, () => new Map());

  for (let b = 0; b < N; b++) {
    const parts = splitPath(routes[b]!);
    const isWild = isWildcardRoute(parts);
    const prefixLen = prefixLength(parts);
    // bitshift by 5 = divide by 32 and floor, since each bitmask word is 32 bits
    const word = b >>> 5;
    // 31 = 2^5 - 1, bitwise AND with 31 to get the bit position within the word
    const bit = 1 << (b & 31);

    // Wildcards are alive at every depth > prefixLen.
    if (isWild) {
      for (let d = prefixLen + 1; d <= maxDepth + 2; d++) {
        depthMask[d * W + word] = depthMask[d * W + word]! | bit;
      }
    } else {
      depthMask[parts.length * W + word] = depthMask[parts.length * W + word]! | bit;
    }

    for (let i = 0; i < prefixLen; i++) {
      const segment = parts[i]!;
      if (segment[0] === ":") {
        anyMask[i * W + word] = anyMask[i * W + word]! | bit;
      } else {
        const litMap = literalMaps[i]!;
        const prev = litMap.get(segment) ?? new Array(W).fill(0);
        prev[word] = (prev[word] ?? 0) | bit | 0; // `| 0` coerces to int32 for V8
        litMap.set(segment, prev);
      }
    }

    if (isWild) {
      for (let i = prefixLen; i <= maxDepth + 1; i++) anyMask[i * W + word] = anyMask[i * W + word]! | bit;
    }
  }

  // Build discriminator table
  // Safe upper bound: the fallback path in resolveDiscriminators can emit up to
  // N entries per segment position (one per route), so N * (maxDepth + 2) is a
  // correct ceiling. Using literalMaps[i].size as the bound is insufficient
  // when multiple same-length literals require full-string fallback entries.

  const totalEntries = 1 + N * (maxDepth + 2); // slot 0 = zero sentinel
  const discMasks = new Int32Array((totalEntries + 8) * W);

  const discs: Discriminator[][] = [];
  const counter: IndexCounter = { idx: 1 };

  for (let i = 0; i <= maxDepth + 1; i++) {
    const literalMap = literalMaps[i]!;
    if (literalMap.size === 0) {
      discs.push([]);
      continue;
    }
    const entries: Discriminator[] = [];
    const byLength = new Map<number, Array<[string, number[]]>>();
    for (const [lit, mask] of literalMap) {
      const g = byLength.get(lit.length) ?? [];
      g.push([lit, mask]);
      byLength.set(lit.length, g);
    }
    for (const [len, group] of byLength) {
      resolveDiscriminators(group, len, [-1, -1, -1], 0, entries, discMasks, W, counter);
    }
    discs.push(entries);
  }

  //  Static route map - O(1) exact match for pure-literal routes

  const staticMap = new Map<string, number>();
  for (let b = 0; b < N; b++) {
    const parts = splitPath(routes[b]!);
    if (!isWildcardRoute(parts) && parts.every((p) => p[0] !== ":")) {
      staticMap.set(routes[b]!, b);
    }
  }

  // Segment-boundary scratch buffers, allocated once and reused across calls
  // to avoid per-call allocation and GC overhead.
  // Caller invariant: never await between the match function returning and
  // reading the segment boundaries. Violating this causes a race condition.
  const segStart = new Int16Array(maxDepth + 2);
  const segEnd = new Int16Array(maxDepth + 2);

  //  Generate width-specialized match function

  const match = generateMatchFunction(W, depthMask, anyMask, discMasks, discs, staticMap, segStart, segEnd, maxDepth);

  return {
    match,
    segStart,
    segEnd,
    get routeCount() {
      return N;
    },
    get W() {
      return W;
    },
    get maxDepth() {
      return maxDepth;
    },
  };
}

/** Returns `true` if the last segment is a wildcard (`*…`). */
function isWildcardRoute(parts: string[]): boolean {
  const last = parts.at(-1);
  return last?.[0] === "*";
}

/** Returns the number of matchable prefix segments (excludes a trailing wildcard). */
function prefixLength(parts: string[]): number {
  return isWildcardRoute(parts) ? parts.length - 1 : parts.length;
}

/**
 * Recursively resolves a group of same-length literals into {@link Discriminator}
 * entries by selecting distinguishing character offsets.
 *
 * The algorithm greedily picks character positions that partition the group
 * into singletons. If up to three probes (`c1`-`c3`) are insufficient, it
 * falls back to a full-literal comparison.
 *
 * @param group - Array of `[literal, bitmask]` pairs sharing the same segment length.
 * @param len - Shared segment length of every literal in the group.
 * @param chosen - Fixed 3-slot buffer of already-selected probe offsets. Only the first
 *   {@link chosenCount} slots are valid; remaining slots hold `-1`. Mutated
 *   in place during recursion and restored to `-1` on backtrack.
 * @param chosenCount - Number of probe offsets currently committed in {@link chosen}.
 * @param result - Accumulator for the resolved {@link Discriminator} entries.
 * @param discMasks - Flat `Int32Array` of per-entry bitmasks (`entryIndex * W`).
 * @param W - Number of 32-bit words per bitmask row.
 * @param counter - Shared row-allocation counter.
 */
function resolveDiscriminators(
  group: Array<[string, number[]]>,
  len: number,
  chosen: [number, number, number],
  chosenCount: number,
  result: Discriminator[],
  discMasks: Int32Array,
  W: number,
  counter: IndexCounter,
): void {
  // Base case - single literal needs no further disambiguation.
  // needsLit when probes don't cover every position: char probes alone match
  // any segment of the right length whose probed offsets happen to agree, so
  // unprobed positions must be verified via a full-literal compare. Otherwise
  // a path with the same length and matching probe chars but a different
  // tail would spuriously match (e.g. "/posts/123" vs route "/users/:id").
  if (group.length === 1) {
    const [lit, mask] = group[0]!;
    const entryIndex = counter.idx++;
    const base = entryIndex * W;
    for (let w = 0; w < W; w++) discMasks[base + w] = mask[w]!;
    result.push(createDiscriminator(entryIndex, len, chosen, chosenCount, lit, chosenCount < len));
    return;
  }

  for (let off = 0; off < len; off++) {
    // Skip already-chosen offsets - fully unrolled, O(1), no allocation.
    if (chosenCount > 0 && chosen[0] === off) continue;
    if (chosenCount > 1 && chosen[1] === off) continue;
    if (chosenCount > 2 && chosen[2] === off) continue;

    // Group entries by the character at this offset.
    const charGroups = new Map<number, Array<[string, number[]]>>();
    for (const entry of group) {
      const c = entry[0].charCodeAt(off);
      const g = charGroups.get(c) ?? [];
      g.push(entry);
      charGroups.set(c, g);
    }

    // Perfect split - every char value maps to exactly one literal.
    if ([...charGroups.values()].every((g) => g.length === 1)) {
      chosen[chosenCount] = off;
      for (const [, sub] of charGroups) {
        const [lit, mask] = sub[0]!;
        const entryIndex = counter.idx++;
        const base = entryIndex * W;
        for (let w = 0; w < W; w++) discMasks[base + w] = mask[w]!;
        // See base-case comment: when probes don't cover every position the
        // literal must be verified to prevent spurious matches against inputs
        // with the same probed chars but different unprobed chars.
        result.push(createDiscriminator(entryIndex, len, chosen, chosenCount + 1, lit, chosenCount + 1 < len));
      }
      chosen[chosenCount] = -1;
      return;
    }

    // Partial split - recurse into remaining ambiguous sub-groups.
    if (chosenCount < 2) {
      chosen[chosenCount] = off;
      const tentative: Discriminator[] = [];
      const savedIndex = counter.idx;
      let allResolved = true;

      for (const [, sub] of charGroups) {
        if (sub.length === 1) {
          const [lit, mask] = sub[0]!;
          const entryIndex = counter.idx++;
          const base = entryIndex * W;
          for (let w = 0; w < W; w++) discMasks[base + w] = mask[w]!;
          // See base-case comment: needsLit when probes don't cover every position.
          tentative.push(createDiscriminator(entryIndex, len, chosen, chosenCount + 1, lit, chosenCount + 1 < len));
        } else {
          const before = tentative.length;
          resolveDiscriminators(sub, len, chosen, chosenCount + 1, tentative, discMasks, W, counter);
          if (tentative.slice(before).some((e) => e.lit !== "")) allResolved = false;
        }
      }

      chosen[chosenCount] = -1;

      if (allResolved) {
        result.push(...tentative);
        return;
      }
      counter.idx = savedIndex;
    }
  }

  // Fallback - character probes alone couldn't fully disambiguate.
  for (const [lit, mask] of group) {
    const entryIndex = counter.idx++;
    const base = entryIndex * W;
    for (let w = 0; w < W; w++) discMasks[base + w] = mask[w]!;
    result.push(createDiscriminator(entryIndex, len, chosen, chosenCount, lit, true));
  }
}

/**
 * Constructs a {@link Discriminator} from the selected character-probe offsets.
 *
 * @param entryIndex - Row index into the discriminator mask table.
 * @param len - Expected segment length.
 * @param chosen - Up to three character offsets used as probes.
 * @param chosenCount - How many of `chosen`'s slots are populated.
 * @param lit - The full literal string (used for char-code lookups and optional fallback).
 * @param needsLit - Whether a full-literal comparison is required as a fallback.
 */
function createDiscriminator(
  entryIndex: number,
  len: number,
  chosen: [number, number, number],
  chosenCount: number,
  lit: string,
  needsLit: boolean,
): Discriminator {
  return {
    entryIndex,
    len,
    c1off: chosenCount > 0 ? chosen[0]! : -1,
    c1val: chosenCount > 0 ? lit.charCodeAt(chosen[0]!) : 0,
    c2off: chosenCount > 1 ? chosen[1]! : -1,
    c2val: chosenCount > 1 ? lit.charCodeAt(chosen[1]!) : 0,
    c3off: chosenCount > 2 ? chosen[2]! : -1,
    c3val: chosenCount > 2 ? lit.charCodeAt(chosen[2]!) : 0,
    lit: needsLit ? lit : "",
  };
}

/** Returns the number of trailing zero bits in a 32-bit integer. Returns `32` for input `0`. */
function countTrailingZeros(n: number): number {
  return n === 0 ? 32 : 31 - Math.clz32(n & -n);
}

/**
 * Assembles a width-specialized match function as a string and constructs it
 * via `new Function`, capturing the pre-built bitmask tables in its closure.
 *
 * The generated body contains exactly `W` named locals (`w0`..`w{W-1}`), one
 * per bitmask word, and no width-dependent branches: width-specific
 * straight-line code the runtime can optimize similarly to hand-written
 * specialized code.
 *
 * The discriminator loop is a fixed template identical for every `W`.
 */
function generateMatchFunction(
  W: number,
  depthMask: Int32Array,
  anyMask: Int32Array,
  discMasks: Int32Array,
  discs: Discriminator[][],
  staticMap: Map<string, number>,
  segStart: Int16Array,
  segEnd: Int16Array,
  maxDepth: number, // used only at build time to bake the depth guard literal into generated code
): (path: string) => number {
  const words = Array.from({ length: W }, (_, i) => i);
  const wordMask = words.map((w) => `w${w}`).join(" | ");

  const lines: string[] = [];
  const add = (...ls: string[]) => lines.push(...ls);

  // Tier-0: static map exact match.
  add(`  const exact = staticMap.get(path);`, `  if (exact !== undefined) return exact;`, ``);

  // Fast-path for root / single-slash paths.
  add(
    `  const len = path.length;`,
    `  if (len <= 1) {`,
    ...words.map((w) => `    if (depthMask[${w}] !== 0) return ${w * 32} + ctz32fn(depthMask[${w}]);`),
    `    return -1;`,
    `  }`,
    ``,
  );

  // Segment boundary scan.
  add(
    `  let d = 0;`,
    `  segStart[0] = 1;`,
    `  for (let i = 1; i < len; i++) {`,
    `    if (path.charCodeAt(i) === 47) { segEnd[d] = i; segStart[++d] = i + 1; }`,
    `  }`,
    `  segEnd[d++] = len;`,
    `  if (d > ${maxDepth + 2}) return -1;`,
    ``,
  );

  // Tier-1: depth filter - W named locals, one per bitmask word.
  add(...words.map((w) => `  let w${w} = depthMask[d * ${W} + ${w}];`), `  if ((${wordMask}) === 0) return -1;`, ``);

  // Tier-2: per-segment discriminator loop.
  add(
    `  for (let seg = 0; seg < d; seg++) {`,
    `    const start = segStart[seg];`,
    `    const end = segEnd[seg];`,
    `    const segLen = end - start;`,
    `    const es = discs[seg];`,
    `    const aBase = seg * ${W};`,
    ``,
    `    let eIdx = 0;`,
    `    for (let e = 0; e < es.length; e++) {`,
    `      const disc = es[e];`,
    `      if (segLen !== disc.len) continue;`,
    `      if (disc.c1off !== -1 && path.charCodeAt(start + disc.c1off) !== disc.c1val) continue;`,
    `      if (disc.c2off !== -1 && path.charCodeAt(start + disc.c2off) !== disc.c2val) continue;`,
    `      if (disc.c3off !== -1 && path.charCodeAt(start + disc.c3off) !== disc.c3val) continue;`,
    `      if (disc.lit !== '' && path.slice(start, end) !== disc.lit) continue;`,
    `      eIdx = disc.entryIndex;`,
    `      break;`,
    `    }`,
    ``,
    `    const xBase = eIdx * ${W};`,
    ...words.map((w) => `    w${w} &= discMasks[xBase + ${w}] | anyMask[aBase + ${w}];`),
    `    if ((${wordMask}) === 0) return -1;`,
    `  }`,
    ``,
  );

  // Winner: lowest set bit = highest-priority route.
  add(...words.map((w) => `  if (w${w} !== 0) return ${w * 32} + ctz32fn(w${w});`), `  return -1;`);

  const src = lines.join("\n");

  try {
    return new Function(
      "depthMask",
      "anyMask",
      "discMasks",
      "discs",
      "staticMap",
      "segStart",
      "segEnd",
      "ctz32fn",
      `return function matchFlare(path) {\n${src}\n//# sourceURL=flare://router/matchFlare\n};`,
      // new Function's call result is untyped; the cast restates the signature the
      // assembled source above is built to satisfy.
    )(depthMask, anyMask, discMasks, discs, staticMap, segStart, segEnd, countTrailingZeros) as (
      path: string,
    ) => number;
  } catch (err) {
    // On Workers, new Function() during startup requires a compatibility date of
    // 2025-06-01 or later (or the allow_eval_during_startup flag); when the runtime
    // blocks it, name the real cause instead of surfacing a generic boot failure.
    if (err instanceof EvalError || (err instanceof Error && /eval|code generation/i.test(err.message))) {
      throw new Error(
        "[flare] router compilation uses new Function() at startup. On Cloudflare Workers this requires "
          + "compatibility_date >= 2025-06-01 or the allow_eval_during_startup compatibility flag. "
          + `Original error: ${(err as Error).message}`,
      );
    }
    throw err;
  }
}
