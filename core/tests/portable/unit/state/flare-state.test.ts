/**
 * Unit tests for {@link flareState} token builder and accessor helpers.
 */
import { describe, it, expect } from "vitest";
import type { StateGetter, TypedStateToken } from "../../../../src/lib/state/flare-state.js";
import { flareState } from "../../../../src/lib/state/flare-state.js";
import { getTokenDefault, getTokenDerivation, getTokenLogMapper } from "../../../../src/lib/state/read.js";

describe("flareState", () => {
  it("Returns a token whose type carrier is purely phantom (no runtime `_type` property).", () => {
    const builder = flareState<number>("Counter");
    // The `_type` phantom exists only at compile time; the token satisfies
    // TypedStateToken<number> with no runtime trace of the carrier.
    expect("_type" in (builder as object)).toBe(false);
    const typed: TypedStateToken<number> = builder;
    expect(typed.name).toBe("Counter");
  });

  it('`name` defaults to `"(anonymous state)"` when omitted.', () => {
    const builder = flareState<number>();
    expect(builder.name).toBe("(anonymous state)");
  });

  it("Token reference identity is stable across builder chains.", () => {
    const token = flareState<number>("Counter");
    const afterDefault = token.withDefault(0);
    const afterFrom = afterDefault.from(() => 1);
    // Each builder method returns the same underlying token object.
    expect(afterDefault as unknown).toBe(token);
    expect(afterFrom as unknown).toBe(token);
  });
});

describe("default value configuration", () => {
  it('Sets the default value; second call throws "can only be called once".', () => {
    const token = flareState<number>("Counter");
    token.withDefault(42);
    expect(getTokenDefault(token as TypedStateToken<number>)).toBe(42);
    expect(() => token.withDefault(99)).toThrow(
      "[Flare] withDefault() can only be called once per token.",
    );
  });

  it('`undefined` value throws "withDefault() value cannot be undefined".', () => {
    const token = flareState<number | undefined>("MaybeNumber");
    expect(() => token.withDefault(undefined)).toThrow(
      "[Flare] withDefault() value cannot be undefined.",
    );
  });
});

describe("derivation function configuration", () => {
  it("Sets the derivation function; second call throws.", () => {
    const token = flareState<number>("Counter");
    const fn = () => 7;
    token.from(fn);
    expect(getTokenDerivation(token as TypedStateToken<number>)).toBe(fn);
    expect(() => token.from(() => 9)).toThrow(
      "[Flare] from() can only be called once per token.",
    );
  });
});

describe("log mapper configuration", () => {
  it("Sets the log mapper; second call throws.", () => {
    const token = flareState<number>("Counter");
    const mapper = (value: number) => ({ value });
    token.withLogging(mapper);
    expect(getTokenLogMapper(token as TypedStateToken<number>)).toBe(mapper);
    expect(() => token.withLogging((v) => ({ v }))).toThrow(
      "[Flare] withLogging() can only be called once per token.",
    );
  });
});

describe("Ordering combinations", () => {
  it("`.withDefault().from()`: both stored; getTokenDefault and getTokenDerivation return both values.", () => {
    const token = flareState<number>("A");
    const fn = (_ctx: StateGetter) => 10;
    const built = token.withDefault(5).from(fn);
    expect(getTokenDefault(built as TypedStateToken<number>)).toBe(5);
    expect(getTokenDerivation(built as TypedStateToken<number>)).toBe(fn);
  });

  it("`.from().withDefault()`: same result.", () => {
    const token = flareState<number>("B");
    const fn = (_ctx: StateGetter) => 10;
    const built = token.from(fn).withDefault(5);
    expect(getTokenDefault(built as TypedStateToken<number>)).toBe(5);
    expect(getTokenDerivation(built as TypedStateToken<number>)).toBe(fn);
  });

  it("`.withDefault().withLogging().from()`: all three stored.", () => {
    const token = flareState<number>("C");
    const fn = (_ctx: StateGetter) => 10;
    const mapper = (value: number) => ({ value });
    const built = token.withDefault(5).withLogging(mapper).from(fn);
    expect(getTokenDefault(built as TypedStateToken<number>)).toBe(5);
    expect(getTokenLogMapper(built as TypedStateToken<number>)).toBe(mapper);
    expect(getTokenDerivation(built as TypedStateToken<number>)).toBe(fn);
  });
});

describe("reading configured token properties", () => {
  it("Return the value stored on the internal symbol.", () => {
    const token = flareState<number>("D");
    const fn = (_ctx: StateGetter) => 1;
    const mapper = (value: number) => ({ value });
    const built = token.withDefault(2).from(fn).withLogging(mapper);
    expect(getTokenDefault(built as TypedStateToken<number>)).toBe(2);
    expect(getTokenDerivation(built as TypedStateToken<number>)).toBe(fn);
    expect(getTokenLogMapper(built as TypedStateToken<number>)).toBe(mapper);
  });

  it("Return undefined when builder method was never called for that property.", () => {
    const token = flareState<number>("E");
    expect(getTokenDefault(token as TypedStateToken<number>)).toBeUndefined();
    expect(getTokenDerivation(token as TypedStateToken<number>)).toBeUndefined();
    expect(getTokenLogMapper(token as TypedStateToken<number>)).toBeUndefined();
  });
});
