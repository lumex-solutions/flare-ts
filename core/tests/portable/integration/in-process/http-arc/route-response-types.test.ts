/**
 * Compile-time claims for typed responses. On a route that declares `response`, every value its handler
 * returns is checked against it: a declared status carries its schema's type (a `date` field takes a
 * Date), a bare return is status 200, a response without a body and a `Response` always pass, and a
 * body on an undeclared status does not. A route without `response` returns JSON data, a model instance,
 * a FlareResponse, a Response, or a stream. A class controller's methods are checked the same way at
 * `controller()`, against the contract entry each is named for. The file passing `tsc` IS the assertion
 * (the `@ts-expect-error` lines fail the build if they stop erroring); the single runtime `it` only
 * anchors it as a vitest file.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { array, date, model, schema, str } from "@flare-ts/lib/schema";
import { Get, Post } from "../../../../../src/decorators.js";
import { ControllerBase, FlareResponse, httpContract } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

const Order = schema({ id: str, placedAt: date, tags: array(str) });
const Conflict = schema({ reason: str });
const ORDER = { response: { 200: Order, 409: Conflict } };

class OrderModel extends model({ id: str, placedAt: date }) {}

class Cart {
  id = "cart-1";
}

declare const found: boolean;
declare const orderModel: OrderModel;
declare const cart: Cart;
const placedAt = new Date("2026-10-29T10:00:00.000Z");
const TAGS = ["gift", "express"] as const;
const order = { id: "o1", placedAt, tags: TAGS };

const host = testHost();

// A declared status carries its schema's type: a Date for the date field, readonly arrays included.
host.http.get("/a1", ORDER, () => new FlareResponse(200, order));
// A bare return is status 200.
host.http.get("/a2", ORDER, () => order);
// A response without a body passes on any status, and so does a Response.
host.http.get("/a3", ORDER, () => new FlareResponse(204));
host.http.get("/a4", ORDER, () => Response.redirect("https://example.com/orders/o1"));
// Every branch of an async handler is checked.
host.http.get("/a5", ORDER, async () => found ? order : new FlareResponse(409, { reason: "taken" }));
// A handler that only throws returns nothing to check.
host.http.get("/a6", ORDER, () => {
  throw new Error("not found");
});

// @ts-expect-error - a date field takes a Date; the compiled serializer writes a string there as null
host.http.get("/b1", ORDER, () => new FlareResponse(200, { id: "o1", placedAt: "2026-10-29", tags: [] }));
// @ts-expect-error - a bare return is status 200, and this body lacks the 200 schema's fields
host.http.get("/b2", ORDER, () => ({ id: "o1" }));
// @ts-expect-error - 201 is not declared in response, and the response has a body
host.http.get("/b3", ORDER, () => new FlareResponse(201, order));
// @ts-expect-error - the 409 branch does not match the 409 schema
host.http.get("/b4", ORDER, async () => found ? order : new FlareResponse(409, { why: "taken" }));

// A contract entry's response is checked the same way.
const Api = httpContract({ getOrder: { response: { 200: Order } } });
host.http.get("/c1", { contract: Api.getOrder }, () => order);
// @ts-expect-error - the contract entry's 200 schema needs placedAt and tags
host.http.get("/c2", { contract: Api.getOrder }, () => ({ id: "o1" }));

// Without `response`, a bare return is JSON data, a Date included, or a model instance.
host.http.get("/d1", () => ({ id: "o1", placedAt }));
host.http.get("/d2", () => orderModel);
// @ts-expect-error - JSON.stringify writes a Map as {}
host.http.get("/d3", () => new Map([["mug", 2]]));
// @ts-expect-error - another class's instance is not JSON data
host.http.get("/d4", () => cart);

const Orders = httpContract({
  show: { response: { 200: Order } },
  place: { body: schema({ sku: str }), response: { 201: Order } },
});

class OrdersController extends ControllerBase {
  static override deps = [];
  static override state = [];
  static override contract = Orders;

  @Get("/:id")
  show() {
    return found ? this.ok(order) : this.noContent();
  }

  @Post("")
  async place() {
    return this.created(order);
  }
}

class StaleOrdersController extends ControllerBase {
  static override deps = [];
  static override state = [];
  static override contract = Orders;

  @Get("/:id")
  show() {
    return this.ok({ id: "o1", placedAt: "2026-10-29", tags: [] });
  }

  @Post("")
  async place() {
    return this.created(order);
  }
}

class HealthController extends ControllerBase {
  static override deps = [];
  static override state = [];

  @Get("")
  check() {
    return this.ok({ up: true });
  }
}

host.http.controller("/orders", OrdersController);
host.http.controller("/health", HealthController);
// @ts-expect-error - show() sends a string where the 200 schema's date field takes a Date
host.http.controller("/stale-orders", StaleOrdersController);

describe("route response types", () => {
  it("compiles: declared responses check every return, and routes without them return JSON or responses", () => {
    expect(true).toBe(true);
  });
});
