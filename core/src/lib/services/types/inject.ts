/**
 * The inject vocabulary: the declaration map developers write, the resolved-instance
 * map derived from it, and the injected projection of a resolved service.
 */
import type { FlareBase } from "../composition/flare-base.js";
import type { FlareService } from "../composition/flare-service.js";
import type { ServiceToken } from "./token.js";

/** Strips all symbol-keyed members (framework internal symbols like SET_HOST_STATE). */
type OmitSymbols<T> = { [K in keyof T as K extends symbol ? never : K]: T[K]; };

/**
 * Exposes the public surface of an injected service.
 *
 * Strips framework internals (`inject`, `onStart`, `onStop`, `dispose`) and all
 * symbol-keyed members so callers only see the service's own domain API. Route
 * handlers and `this.inject()` receive services as this type, so a function that
 * takes an injected service types its parameter with it; the service class fits too.
 *
 * @example
 * ```ts
 * function chargeOrder(payments: Injected<PaymentsClient>, order: Order): Promise<Receipt> {
 *   return payments.charge(order.customerId, order.totalCents);
 * }
 *
 * host.http.post(
 *   "/orders/:id/pay",
 *   { route: { id: int }, inject: { orders: OrdersRepository, payments: PaymentsClient } },
 *   async (_ctx, { input, orders, payments }) => chargeOrder(payments, await orders.find(input.route.id)),
 * );
 * ```
 */
export type Injected<T extends FlareBase> = OmitSymbols<Omit<T, "inject" | "onStart" | "onStop" | "dispose">>;

/**
 * Resolved-instance map derived from a declared `inject` token map.
 *
 * The reserved `config` key (carried as an optional `never` on {@link InjectMap}) is excluded so it
 * never collides with the scope's `config` accessor.
 */
export type InjectedMap<D extends Record<string, ServiceToken<FlareService>>> = {
  [K in keyof D as K extends "config" | "input" ? never : K]: D[K] extends ServiceToken<infer T> ? Injected<T>
    : never;
};

/**
 * `inject` declaration map.
 *
 * `config` and `input` are reserved (they are the scope's config accessor
 * and parsed-request accessor).
 */
export type InjectMap = Record<string, ServiceToken<FlareService>> & { config?: never; input?: never; };
