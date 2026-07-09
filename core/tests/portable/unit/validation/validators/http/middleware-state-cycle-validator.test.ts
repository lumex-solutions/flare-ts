/**
 * Unit tests for {@link MiddlewareStateCycleValidator} circular state dependency detection.
 */
import { describe, it, expect } from "vitest";
import type { MiddlewareClass } from "../../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type { MiddlewareRegistration } from "../../../../../../src/lib/arcs/http/types/registration.js";
import type { StateToken } from "../../../../../../src/lib/state/flare-state.js";
import type { HttpValidationContext } from "../../../../../../src/lib/validation/contexts.js";
import { MiddlewareStateCycleValidator } from "../../../../../../src/lib/validation/validators/http/middleware-state-cycle-validator.js";

type MwOpts = {
  state?: StateToken[];
  provides?: StateToken[];
};

function token(name: string): StateToken {
  return { name };
}

function makeMwReg(name: string, opts: MwOpts = {}): MiddlewareRegistration {
  const cls = {
    name,
    state: opts.state ?? [],
    provides: opts.provides,
  } as unknown as MiddlewareClass;
  return {
    factory: (() => undefined) as never,
    cls,
  };
}

function makeContext(globalMiddleware: MiddlewareRegistration[]): HttpValidationContext {
  return {
    controllers: [],
    globalMiddleware,
    groups: [],
  };
}

describe("middleware state dependency cycles", () => {
  it("returns [] when globalMiddleware is empty", () => {
    const errors = new MiddlewareStateCycleValidator().validate(makeContext([]));
    expect(errors).toEqual([]);
  });

  it("returns [] for a linear chain A->T1, B requires T1 & provides T2, C requires T2", () => {
    const t1 = token("T1");
    const t2 = token("T2");
    const a = makeMwReg("A", { provides: [t1] });
    const b = makeMwReg("B", { state: [t1], provides: [t2] });
    const c = makeMwReg("C", { state: [t2] });

    const errors = new MiddlewareStateCycleValidator().validate(
      makeContext([a, b, c]),
    );

    expect(errors).toEqual([]);
  });

  it("reports a single MIDDLEWARE_STATE_CYCLE for two middleware that require each other's state", () => {
    const tA = token("TA");
    const tB = token("TB");
    const a = makeMwReg("A", { state: [tB], provides: [tA] });
    const b = makeMwReg("B", { state: [tA], provides: [tB] });

    const errors = new MiddlewareStateCycleValidator().validate(
      makeContext([a, b]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("MIDDLEWARE_STATE_CYCLE");
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.message).toContain("Circular state dependency in middleware chain:");
  });

  it("reports a single MIDDLEWARE_STATE_CYCLE with the full cycle path for a three-node cycle", () => {
    const tA = token("TA");
    const tB = token("TB");
    const tC = token("TC");
    // A requires C's token, B requires A's token, C requires B's token (cycle A, C, B).
    const a = makeMwReg("A", { state: [tC], provides: [tA] });
    const b = makeMwReg("B", { state: [tA], provides: [tB] });
    const c = makeMwReg("C", { state: [tB], provides: [tC] });

    const errors = new MiddlewareStateCycleValidator().validate(
      makeContext([a, b, c]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("MIDDLEWARE_STATE_CYCLE");
    // The full cycle path must mention all three nodes.
    const msg = errors[0]!.message;
    expect(msg).toContain("A");
    expect(msg).toContain("B");
    expect(msg).toContain("C");
    expect(msg).toContain("->");
  });

  it("dedupes a single cycle across multiple entry points (reportedCycles)", () => {
    // Two-node cycle visited from both A and B as separate DFS entry points.
    const tA = token("TA");
    const tB = token("TB");
    const a = makeMwReg("A", { state: [tB], provides: [tA] });
    const b = makeMwReg("B", { state: [tA], provides: [tB] });

    const errors = new MiddlewareStateCycleValidator().validate(
      makeContext([a, b]),
    );

    // Even though the DFS starts from both a and b, only one cycle should be reported.
    expect(errors).toHaveLength(1);
  });

  it("does not flag a middleware that requires a token no other middleware provides", () => {
    const unknown = token("UNKNOWN");
    const a = makeMwReg("A", { state: [unknown] });

    const errors = new MiddlewareStateCycleValidator().validate(makeContext([a]));

    expect(errors).toEqual([]);
  });

  it("treats a middleware with empty state and no provides as having no edges", () => {
    const a = makeMwReg("A");
    const b = makeMwReg("B");

    const errors = new MiddlewareStateCycleValidator().validate(makeContext([a, b]));

    expect(errors).toEqual([]);
  });
});
