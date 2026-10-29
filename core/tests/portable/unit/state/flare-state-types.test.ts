/**
 * Compile-time claims for `.withLogging()`: the mapper receives the state as DeepReadonly and may return
 * its readonly fields as they are, but not a Date. The file passing `tsc` IS the assertion (the
 * `@ts-expect-error` line fails the build if it stops erroring); the single runtime `it` only anchors it
 * as a vitest file.
 */
import { describe, expect, it } from "vitest";
import { flareState } from "../../../../src/lib/state/flare-state.js";

const _session = () =>
  flareState<{ userId: string; roles: string[]; }>("Session")
    .withLogging((session) => ({ userId: session.userId, roles: session.roles }));

const _checkout = () =>
  flareState<{ cartId: string; }>("Checkout")
    // @ts-expect-error - a Date goes in as date.toISOString()
    .withLogging((checkout) => ({ cartId: checkout.cartId, loggedAt: new Date() }));

describe("flareState types", () => {
  it("compiles: a log mapper returns readonly state fields as they are, not a Date", () => {
    expect(true).toBe(true);
  });
});
