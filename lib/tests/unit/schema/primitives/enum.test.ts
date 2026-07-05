/**
 * Unit tests for the enums primitive: tuple validation, lut literals, and jsonSchema emission.
 */
import { describe, expect, it } from "vitest";
import { enums } from "../../../../src/schema/primitives/enum.js";

describe("enum primitive validation", () => {
  it("returns the value unchanged when present in the tuple", () => {
    const role = enums(["admin", "user", "guest"] as const);
    expect(role("admin")).toBe("admin");
    expect(role("user")).toBe("user");
    expect(role("guest")).toBe("guest");
  });

  it("throws 'Expected one of [a, b, c], got \"<v>\"' when value is not in tuple", () => {
    const role = enums(["a", "b", "c"] as const);
    expect(() => role("d")).toThrow('Expected one of [a, b, c], got "d"');
  });

  it("lut maps each value to its pre-quoted JSON literal", () => {
    const role = enums(["admin", "user"] as const);
    expect(role.lut).toEqual({
      admin: '"admin"',
      user: '"user"',
    });
  });

  it("jsonSchema is { type: 'string', enum: values }", () => {
    const values = ["admin", "user", "guest"] as const;
    const role = enums(values);
    expect(role.jsonSchema).toEqual({ type: "string", enum: values });
  });
});
