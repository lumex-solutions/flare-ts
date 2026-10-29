/**
 * Compile-time claims for ModelInstance: a model() instance satisfies it, another class's instance does
 * not, and plain data still assigns to a model class's type. The file passing `tsc` IS the assertion
 * (the `@ts-expect-error` lines fail the build if they stop erroring); the single runtime `it` only
 * anchors it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import type { ModelInstance } from "../../../src/schema/index.js";
import { int, model, str } from "../../../src/schema/index.js";

class Order extends model({ id: str, quantity: int }) {}

class Cart {
  id = "cart-1";
}

declare const order: Order;
declare const parsed: { id: string; quantity: number; };

const _instance = (): ModelInstance => order;
const _plain = (): Order => parsed;
// @ts-expect-error - only a model() instance carries the marker
const _otherClass = (): ModelInstance => new Cart();
// @ts-expect-error - a Map is not a model instance
const _map = (): ModelInstance => new Map<string, number>();

describe("ModelInstance types", () => {
  it("compiles: a model instance is a ModelInstance, other class instances are not, plain data is an Order", () => {
    expect(true).toBe(true);
  });
});
