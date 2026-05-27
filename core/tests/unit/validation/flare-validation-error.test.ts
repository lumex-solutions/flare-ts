import { describe, it, expect } from "vitest";
import type { ValidationError } from "../../../src/lib/validation/types.js";
import { FlareValidationError } from "../../../src/lib/validation/flare-validation-error.js";

describe("FlareValidationError", () => {
  it('includes "Build failed with 1 validation error" (singular) when constructed with a single error entry', () => {
    const entries: ValidationError[] = [
      { severity: "error", code: "BAD_THING", message: "something broke" },
    ];

    const err = new FlareValidationError(entries);

    expect(err.message).toContain("Build failed with 1 validation error");
    expect(err.message).not.toContain("Build failed with 1 validation errors");
  });

  it('includes "Build failed with 2 validation errors" (plural) and lists both numbered 1. and 2.', () => {
    const entries: ValidationError[] = [
      { severity: "error", code: "FIRST", message: "first problem" },
      { severity: "error", code: "SECOND", message: "second problem" },
    ];

    const err = new FlareValidationError(entries);

    expect(err.message).toContain("Build failed with 2 validation errors");
    expect(err.message).toContain("  1. [FIRST] first problem");
    expect(err.message).toContain("  2. [SECOND] second problem");
  });

  it("filters warnings out of the formatted message but retains them on this.errors", () => {
    const entries: ValidationError[] = [
      { severity: "error", code: "REAL_ERROR", message: "real" },
      { severity: "warning", code: "JUST_A_WARN", message: "warn text" },
    ];

    const err = new FlareValidationError(entries);

    expect(err.message).toContain("Build failed with 1 validation error");
    expect(err.message).toContain("[REAL_ERROR] real");
    expect(err.message).not.toContain("JUST_A_WARN");
    expect(err.message).not.toContain("warn text");
    expect(err.errors).toEqual(entries);
  });

  it('reports "Build failed with 0 validation errors" with an empty body when all entries are warnings, but retains the warnings on this.errors', () => {
    const entries: ValidationError[] = [
      { severity: "warning", code: "W1", message: "warning one" },
      { severity: "warning", code: "W2", message: "warning two" },
    ];

    const err = new FlareValidationError(entries);

    expect(err.message).toContain("Build failed with 0 validation errors");
    expect(err.message).not.toContain("W1");
    expect(err.message).not.toContain("W2");
    expect(err.errors).toEqual(entries);
    expect(err.errors).toHaveLength(2);
  });

  it("omits the Hint: suffix on the message line when an entry has no hint", () => {
    const entries: ValidationError[] = [
      { severity: "error", code: "NO_HINT", message: "no hint here" },
    ];

    const err = new FlareValidationError(entries);

    expect(err.message).toContain("  1. [NO_HINT] no hint here");
    expect(err.message).not.toContain("Hint:");
  });

  it('includes "\\n     Hint: <hint>" on the message line when an entry has a hint', () => {
    const entries: ValidationError[] = [
      { severity: "error", code: "WITH_HINT", message: "needs a hint", hint: "try this" },
    ];

    const err = new FlareValidationError(entries);

    expect(err.message).toContain("  1. [WITH_HINT] needs a hint\n     Hint: try this");
  });

  it('sets name to "FlareValidationError"', () => {
    const err = new FlareValidationError([
      { severity: "error", code: "X", message: "x" },
    ]);

    expect(err.name).toBe("FlareValidationError");
  });

  it("exposes errors as the original input array, including warnings", () => {
    const entries: ValidationError[] = [
      { severity: "error", code: "E", message: "e" },
      { severity: "warning", code: "W", message: "w" },
    ];

    const err = new FlareValidationError(entries);

    expect(err.errors).toBe(entries);
  });

  it("is instanceof Error and instanceof FlareValidationError", () => {
    const err = new FlareValidationError([
      { severity: "error", code: "X", message: "x" },
    ]);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FlareValidationError);
  });
});
