/**
 * Compile-time claims for flareState: a state type is plain data (a StateValue), so a Date or Map in it
 * fails to compile, as setting it would throw; and a `.withLogging()` mapper may return its readonly
 * fields as they are, and a Date, but not a Map. The file passing `tsc` IS the assertion (the
 * `@ts-expect-error` lines fail the build if they stop erroring); the single runtime `it` only anchors
 * it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import { flareState } from "../../../../src/lib/state/flare-state.js";

const _requestId = () => flareState<string>("RequestId");
const _cart = () => flareState<{ cartId: string; skus: string[]; expiresAt: number; }>("Cart");
// @ts-expect-error - setting a Date in state throws; keep a time as an ISO string or a number
const _visit = () => flareState<{ at: Date; }>("Visit");
// @ts-expect-error - setting a Map in state throws
const _counts = () => flareState<{ bySku: Map<string, number>; }>("Counts");

const _session = () =>
  flareState<{ userId: string; roles: string[]; }>("Session")
    .withLogging((session) => ({ userId: session.userId, roles: session.roles }));

const _checkout = () =>
  flareState<{ cartId: string; }>("Checkout")
    .withLogging((checkout) => ({ cartId: checkout.cartId, loggedAt: new Date() }));

const _stock = () =>
  flareState<{ skus: string[]; }>("Stock")
    // @ts-expect-error - JSON.stringify writes a Map as {}
    .withLogging((stock) => ({ bySku: new Map(stock.skus.map((sku) => [sku, 1])) }));

describe("flareState types", () => {
  it("compiles: state is plain data, and a log mapper returns its readonly fields as they are", () => {
    expect(true).toBe(true);
  });
});
