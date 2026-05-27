import { describe, it, expect } from "vitest";
import type { IValidator } from "../../../src/lib/validation/types.js";
import { CompositeValidator } from "../../../src/lib/validation/composite-validator.js";

describe("CompositeValidator", () => {
  it("runs every inner validator in registration order and returns the concatenated ValidationError[]", () => {
    const calls: string[] = [];

    const a: IValidator<{ tag: string; }> = {
      validate: ctx => {
        calls.push(`a:${ctx.tag}`);
        return [{ severity: "error", code: "A", message: "from a" }];
      },
    };
    const b: IValidator<{ tag: string; }> = {
      validate: ctx => {
        calls.push(`b:${ctx.tag}`);
        return [{ severity: "warning", code: "B", message: "from b" }];
      },
    };
    const c: IValidator<{ tag: string; }> = {
      validate: ctx => {
        calls.push(`c:${ctx.tag}`);
        return [{ severity: "error", code: "C", message: "from c" }];
      },
    };

    const composite = new CompositeValidator<{ tag: string; }>([a, b, c]);
    const errors = composite.validate({ tag: "ctx" });

    expect(calls).toEqual(["a:ctx", "b:ctx", "c:ctx"]);
    expect(errors).toEqual([
      { severity: "error", code: "A", message: "from a" },
      { severity: "warning", code: "B", message: "from b" },
      { severity: "error", code: "C", message: "from c" },
    ]);
  });

  it("returns an empty array without throwing when there are zero inner validators", () => {
    const composite = new CompositeValidator<{ x: number; }>([]);

    const result = composite.validate({ x: 1 });

    expect(result).toEqual([]);
  });

  it("returns an empty array when all inner validators return empty arrays", () => {
    const empty1: IValidator<unknown> = { validate: () => [] };
    const empty2: IValidator<unknown> = { validate: () => [] };
    const empty3: IValidator<unknown> = { validate: () => [] };

    const composite = new CompositeValidator<unknown>([empty1, empty2, empty3]);

    expect(composite.validate({})).toEqual([]);
  });

  it("does not short-circuit when an inner validator returns errors — every subsequent inner validator still runs", () => {
    const calls: string[] = [];

    const failing: IValidator<unknown> = {
      validate: () => {
        calls.push("failing");
        return [
          { severity: "error", code: "E1", message: "bad" },
          { severity: "error", code: "E2", message: "also bad" },
        ];
      },
    };
    const next: IValidator<unknown> = {
      validate: () => {
        calls.push("next");
        return [{ severity: "warning", code: "W", message: "still ran" }];
      },
    };
    const last: IValidator<unknown> = {
      validate: () => {
        calls.push("last");
        return [];
      },
    };

    const composite = new CompositeValidator<unknown>([failing, next, last]);
    const result = composite.validate({});

    expect(calls).toEqual(["failing", "next", "last"]);
    expect(result).toHaveLength(3);
  });

  it("preserves order of errors (inner-validator order, then each validator's own order)", () => {
    const first: IValidator<unknown> = {
      validate: () => [
        { severity: "error", code: "F1", message: "first-1" },
        { severity: "error", code: "F2", message: "first-2" },
      ],
    };
    const second: IValidator<unknown> = {
      validate: () => [
        { severity: "warning", code: "S1", message: "second-1" },
        { severity: "error", code: "S2", message: "second-2" },
      ],
    };

    const composite = new CompositeValidator<unknown>([first, second]);
    const result = composite.validate({});

    expect(result.map(e => e.code)).toEqual(["F1", "F2", "S1", "S2"]);
  });

  it("passes the generic TContext unchanged to every inner validator (no cloning, no wrapping)", () => {
    const ctx = { id: 42, nested: { value: "x" } };
    const received: unknown[] = [];

    const peek1: IValidator<typeof ctx> = {
      validate: c => {
        received.push(c);
        return [];
      },
    };
    const peek2: IValidator<typeof ctx> = {
      validate: c => {
        received.push(c);
        return [];
      },
    };

    const composite = new CompositeValidator<typeof ctx>([peek1, peek2]);
    composite.validate(ctx);

    expect(received).toHaveLength(2);
    expect(received[0]).toBe(ctx);
    expect(received[1]).toBe(ctx);
  });
});
