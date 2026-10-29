/**
 * Compile-time claims for JsonValue and ReadonlyJsonValue: a parsed JsonValue narrows to its object case
 * with `Array.isArray` and holds no Date; ReadonlyJsonValue takes readonly arrays, `as const` values,
 * `undefined` fields, a Date, and every JsonValue; neither takes a Map, bigint, or function. The file
 * passing `tsc` IS the assertion (the `@ts-expect-error` lines fail the build if they stop erroring); the
 * single runtime `it` only anchors it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue, ReadonlyJsonValue } from "../../../src/schema/index.js";

type Order = {
  readonly id: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number; }[];
  readonly couponCode: string | undefined;
  readonly giftNote?: string;
};

declare const parsed: JsonValue;
declare const order: Order;
const STATUSES = ["pending", "paid", "shipped"] as const;

// A parsed value narrows to its object case, and a key read from it may be missing.
const _field = (): JsonValue | undefined =>
  typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed["id"] : undefined;

const _order = (): ReadonlyJsonValue => order;
const _statuses = (): ReadonlyJsonValue => STATUSES;
const _nested = (): ReadonlyJsonValue => ({ orders: [order], statuses: STATUSES });
const _parsed = (): ReadonlyJsonValue => parsed;
const _date = (): ReadonlyJsonValue => ({ placedAt: new Date() });

// @ts-expect-error - a readonly array is not a JsonValue, whose arrays stay mutable so they narrow
const _readonlyAsParsed = (): JsonValue => STATUSES;
// @ts-expect-error - JSON.parse never returns a Date
const _parsedDate = (): JsonValue => ({ placedAt: new Date() });
// @ts-expect-error - JSON.stringify writes a Map as {}
const _map = (): ReadonlyJsonValue => new Map([["mug", 2]]);
// @ts-expect-error - JSON.stringify throws on a bigint
const _bigint = (): ReadonlyJsonValue => ({ total: 1200n });
// @ts-expect-error - JSON.stringify leaves a function out
const _fn = (): ReadonlyJsonValue => ({ total: () => 1200 });

describe("JsonValue types", () => {
  it("compiles: JsonValue narrows, ReadonlyJsonValue takes readonly data, a Date, and every JsonValue", () => {
    expect(true).toBe(true);
  });
});
