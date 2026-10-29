/**
 * Compile-time claims for JSON response bodies: `FlareResponse`, the controller and middleware response
 * helpers, and SSE event data take a ReadonlyJsonValue, so readonly data, `as const` values, and fields
 * that may be `undefined` compile, and a Date does not. The file passing `tsc` IS the assertion (the
 * `@ts-expect-error` line fails the build if it stops erroring); the single runtime `it` only anchors it
 * as a vitest file.
 */
import { describe, expect, it } from "vitest";
import type { SseEvent } from "../../../../../src/lib/arcs/http/transport/sse.js";
import type { ResponseLike } from "../../../../../src/lib/arcs/http/transport/types/response.js";
import { ControllerBase } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";

type OrderSummary = {
  readonly id: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number; }[];
  readonly couponCode: string | undefined;
};

declare const order: OrderSummary;
const STATUSES = ["pending", "paid", "shipped"] as const;

const _created = () => new FlareResponse(201, order, { headers: { Location: `/orders/${order.id}` } });
const _statuses = () => new FlareResponse(200, { statuses: STATUSES });
const _event = (): SseEvent => ({ event: "order", data: order });
// @ts-expect-error - a Date goes in as date.toISOString()
const _date = () => new FlareResponse(200, { placedAt: new Date() });

class OrdersController extends ControllerBase {
  static override deps = [];
  static override state = [];

  show(): ResponseLike {
    return this.ok(order);
  }

  statuses(): ResponseLike {
    return this.ok(STATUSES);
  }
}

class CouponMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];

  reject(): ResponseLike {
    return this.badRequest({ couponCode: order.couponCode, accepted: STATUSES });
  }
}

describe("JSON response body types", () => {
  it("compiles: readonly data, as-const values, and undefined fields are bodies; a Date is not", () => {
    expect([OrdersController, CouponMiddleware]).toHaveLength(2);
  });
});
