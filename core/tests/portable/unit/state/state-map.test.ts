/**
 * Unit tests for {@link StateMap} typed storage, freezing, and retrieval.
 */
import { describe, it, expect } from "vitest";
import type { TypedStateToken } from "../../../../src/lib/state/types/state-token.js";
import { flareState } from "../../../../src/lib/state/flare-state.js";
import { StateMap } from "../../../../src/lib/state/state-map.js";

describe("round-trip storage and retrieval", () => {
  it("Round-trip: setting a primitive value retrieves the same value.", () => {
    const map = new StateMap();
    const token = flareState<number>("N") as TypedStateToken<number>;
    map.set(token, 42);
    expect(map.get(token)).toBe(42);
  });

  it("Round-trip: setting an object retrieves a deeply-frozen snapshot (independent identity).", () => {
    const map = new StateMap();
    const token = flareState<{ a: number; nested: { b: number; }; }>("Obj") as TypedStateToken<{
      a: number;
      nested: { b: number; };
    }>;
    const input = { a: 1, nested: { b: 2 } };
    map.set(token, input);
    const out = map.get(token);
    expect(out).not.toBe(input);
    expect(out).toEqual({ a: 1, nested: { b: 2 } });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen((out as { nested: object; }).nested)).toBe(true);
    // Mutating the original does not change the stored snapshot.
    input.a = 99;
    input.nested.b = 99;
    expect((map.get(token) as { a: number; }).a).toBe(1);
    expect((map.get(token) as { nested: { b: number; }; }).nested.b).toBe(2);
  });

  it("Distinct tokens with same shape: each retains its own value.", () => {
    const map = new StateMap();
    const tokenA = flareState<number>("A") as TypedStateToken<number>;
    const tokenB = flareState<number>("B") as TypedStateToken<number>;
    map.set(tokenA, 1);
    map.set(tokenB, 2);
    expect(map.get(tokenA)).toBe(1);
    expect(map.get(tokenB)).toBe(2);
  });

  it("Missing token: get returns undefined.", () => {
    const map = new StateMap();
    const token = flareState<number>("Missing") as TypedStateToken<number>;
    expect(map.get(token)).toBeUndefined();
  });
});

describe("snapshotStateValue (module-private; exercised via set/get)", () => {
  it("Primitives pass through unchanged.", () => {
    const map = new StateMap();
    const numToken = flareState<number>("num") as TypedStateToken<number>;
    const strToken = flareState<string>("str") as TypedStateToken<string>;
    const boolToken = flareState<boolean>("bool") as TypedStateToken<boolean>;
    const nullToken = flareState<null>("null") as TypedStateToken<null>;
    map.set(numToken, 7);
    map.set(strToken, "hi");
    map.set(boolToken, true);
    map.set(nullToken, null);
    expect(map.get(numToken)).toBe(7);
    expect(map.get(strToken)).toBe("hi");
    expect(map.get(boolToken)).toBe(true);
    expect(map.get(nullToken)).toBe(null);
  });

  it("Array: returns a frozen copy; original mutation does not affect snapshot.", () => {
    const map = new StateMap();
    const token = flareState<number[]>("arr") as TypedStateToken<number[]>;
    const arr = [1, 2, 3];
    map.set(token, arr);
    const stored = map.get(token);
    expect(stored).not.toBe(arr);
    expect(stored).toEqual([1, 2, 3]);
    expect(Object.isFrozen(stored)).toBe(true);
    arr.push(4);
    arr[0] = 99;
    expect(map.get(token)).toEqual([1, 2, 3]);
  });

  it("Plain object: returns a frozen copy with frozen nested values.", () => {
    const map = new StateMap();
    const token = flareState<{ inner: { x: number; }; list: number[]; }>("obj") as TypedStateToken<{
      inner: { x: number; };
      list: number[];
    }>;
    const input = { inner: { x: 1 }, list: [1, 2] };
    map.set(token, input);
    const stored = map.get(token) as { inner: { x: number; }; list: number[]; };
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.inner)).toBe(true);
    expect(Object.isFrozen(stored.list)).toBe(true);
    expect(stored.inner).not.toBe(input.inner);
    expect(stored.list).not.toBe(input.list);
  });

  it('Non-plain object (class instance): throws "must be primitives, arrays, or plain objects".', () => {
    const map = new StateMap();
    class Service {
      kind = "svc";
    }
    const token = flareState<Service>("svc") as TypedStateToken<Service>;
    expect(() => map.set(token, new Service())).toThrow(
      "[flare] State values must be primitives, arrays, or plain objects. Store mutable resources in an injected service instead.",
    );
  });

  it('Circular reference: throws "cannot contain circular references".', () => {
    const map = new StateMap();
    type Cyc = { self?: Cyc; };
    const token = flareState<Cyc>("cyc") as TypedStateToken<Cyc>;
    const obj: Cyc = {};
    obj.self = obj;
    expect(() => map.set(token, obj)).toThrow(
      "[flare] State values cannot contain circular references.",
    );
  });
});
