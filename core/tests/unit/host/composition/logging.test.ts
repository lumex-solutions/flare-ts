import { describe, it, expect } from "vitest";
import type { LoggerTransportClass } from "../../../../src/lib/logger/types.js";
import { Logging } from "../../../../src/lib/host/composition/logging.js";

/**
 * Minimal `LoggerTransportClass`-shaped stubs. `Logging` only stores the class
 * reference — it never constructs or invokes anything — so the constructor body
 * and `transportName` are inert placeholders that satisfy the type.
 */
function makeTransportClass(name: string): LoggerTransportClass {
  return class StubTransport {
    static readonly transportName = name;
    constructor(_container: unknown) {
      // no-op
    }
    write(): void {
      // no-op
    }
  } as unknown as LoggerTransportClass;
}

describe("Logging.loggerTransports (getter)", () => {
  it("returns an empty readonly array on a new instance", () => {
    const logging = new Logging();
    expect(logging.loggerTransports).toEqual([]);
    expect(logging.loggerTransports).toHaveLength(0);
  });

  it("returns the same array reference for repeated reads (no defensive copy)", () => {
    const logging = new Logging();
    const first = logging.loggerTransports;
    const second = logging.loggerTransports;
    expect(second).toBe(first);
  });

  it("reflects values pushed via transport() — readonly is a compile-time contract, runtime still observes registrations", () => {
    const logging = new Logging();
    const initial = logging.loggerTransports;
    expect(initial).toHaveLength(0);

    const A = makeTransportClass("A");
    logging.transport(A);

    // Same getter, same reference, new contents visible after registration.
    const after = logging.loggerTransports;
    expect(after).toBe(initial);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(A);
  });
});

describe("Logging.transport", () => {
  it("a single registered transport class appears in loggerTransports", () => {
    const logging = new Logging();
    const A = makeTransportClass("A");

    logging.transport(A);

    expect(logging.loggerTransports).toHaveLength(1);
    expect(logging.loggerTransports[0]).toBe(A);
  });

  it("multiple registrations preserve insertion order", () => {
    const logging = new Logging();
    const A = makeTransportClass("A");
    const B = makeTransportClass("B");
    const C = makeTransportClass("C");

    logging.transport(A);
    logging.transport(B);
    logging.transport(C);

    expect(logging.loggerTransports).toHaveLength(3);
    expect(logging.loggerTransports[0]).toBe(A);
    expect(logging.loggerTransports[1]).toBe(B);
    expect(logging.loggerTransports[2]).toBe(C);
  });

  it("the same transport class registered twice appears twice (no dedupe)", () => {
    const logging = new Logging();
    const A = makeTransportClass("A");

    logging.transport(A);
    logging.transport(A);

    expect(logging.loggerTransports).toHaveLength(2);
    expect(logging.loggerTransports[0]).toBe(A);
    expect(logging.loggerTransports[1]).toBe(A);
  });
});
