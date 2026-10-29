/**
 * Compile-time claims for a log call's meta: it takes fields that may be `undefined` and readonly arrays,
 * as app code holds them, and not a Date. The file passing `tsc` IS the assertion (the `@ts-expect-error`
 * line fails the build if it stops erroring); the single runtime `it` only anchors it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import type { Logger } from "../../../../src/lib/logger/logger.js";

declare const logger: Logger;
declare const user: { readonly id: string; } | undefined;
const APPROVERS = ["admin", "billing"] as const;

const _optional = () => logger.info("order placed", { orderId: "o1", userId: user?.id });
const _readonly = () => logger.warn("refund over limit", { orderId: "o1", approvers: APPROVERS });
// @ts-expect-error - a Date goes in as date.toISOString()
const _date = () => logger.info("order placed", { placedAt: new Date() });

describe("Logger types", () => {
  it("compiles: meta takes undefined fields and readonly arrays, not a Date", () => {
    expect(true).toBe(true);
  });
});
