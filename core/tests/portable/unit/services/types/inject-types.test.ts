/**
 * Compile-time claims for Injected: what an injected service exposes, and that a function typed with it
 * accepts both the value a route injects and the service itself. The file passing `tsc` IS the assertion
 * (the `@ts-expect-error` lines fail the build if they stop erroring); the single runtime `it` only anchors
 * it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import type { Injected, InjectedMap } from "../../../../../src/lib/services/types/inject.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type Received = InjectedMap<{ payments: typeof PaymentsClient; }>["payments"];

// An injected service exposes its own API only: the lifecycle hooks and inject() are gone.
type _Surface = Expect<Equal<keyof Injected<PaymentsClient>, "charge">>;

// A route's `inject` hands over exactly that projection.
type _Received = Expect<Equal<Received, Injected<PaymentsClient>>>;

class PaymentsClient extends FlareService {
  static override deps = [];
  override onStart(): void {}
  charge(_customerId: string, _cents: number): string {
    return "receipt-1";
  }
}

declare const received: Received;
declare const client: PaymentsClient;

function chargeOrder(payments: Injected<PaymentsClient>, customerId: string, cents: number): string {
  return payments.charge(customerId, cents);
}
const _injected = () => chargeOrder(received, "cus_1", 1200);
const _service = () => chargeOrder(client, "cus_1", 1200);

function chargeOrderTypedByClass(payments: PaymentsClient): string {
  return payments.charge("cus_1", 1200);
}
// @ts-expect-error - the injected projection lacks the lifecycle members, so a parameter typed by the class rejects it
const _byClass = () => chargeOrderTypedByClass(received);

describe("Injected types", () => {
  it("compiles: an injected service exposes its own API, and Injected<T> accepts it and the service itself", () => {
    expect(true).toBe(true);
  });
});
