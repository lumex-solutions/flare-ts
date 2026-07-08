/**
 * Unit tests for toErrorField: normalization of thrown values into the structured
 * record error field.
 */
import { describe, expect, it } from "vitest";
import { toErrorField } from "../../../../src/lib/logger/fields.js";

describe("error field normalization for log records", () => {
  // Primary Behavior
  it("returns name, message, stack for an Error instance", () => {
    const r = toErrorField(new Error("boom"));
    expect(r.name).toBe("Error");
    expect(r.message).toBe("boom");
    expect(typeof r.stack).toBe("string");
  });

  it("preserves the custom class name when given a subclass of Error", () => {
    class FooError extends Error {}
    const r = toErrorField(new FooError("x"));
    expect(r.name).toBe("FooError");
    expect(r.message).toBe("x");
  });

  it("preserves an explicitly set err.name on a plain Error", () => {
    const err = new Error("custom");
    err.name = "CustomName";
    expect(toErrorField(err).name).toBe("CustomName");
  });

  it("omits stack when the Error instance has no stack", () => {
    const err = new Error("nostack");
    // Simulate a stackless error: delete the stack after construction.
    delete (err as { stack?: string; }).stack;

    const r = toErrorField(err);
    expect(r.message).toBe("nostack");
    expect("stack" in r).toBe(false);
  });

  // Edge Cases
  it("non-Error string input returns message only", () => {
    const r = toErrorField("oops");
    expect(r).toEqual({ message: "oops" });
    expect("name" in r).toBe(false);
    expect("stack" in r).toBe(false);
  });

  it("non-Error number input returns message = '42'", () => {
    const r = toErrorField(42);
    expect(r).toEqual({ message: "42" });
  });

  it("non-Error object input returns message = '[object Object]'", () => {
    const r = toErrorField({ a: 1 });
    expect(r).toEqual({ message: "[object Object]" });
  });

  it("null input returns message = 'null'", () => {
    expect(toErrorField(null)).toEqual({ message: "null" });
  });

  it("undefined input returns message = 'undefined'", () => {
    expect(toErrorField(undefined)).toEqual({ message: "undefined" });
  });
});
