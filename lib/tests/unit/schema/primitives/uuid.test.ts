/**
 * Unit tests for the uuid primitive: v4 validation and jsonSchema emission.
 */
import { describe, expect, it } from "vitest";
import { uuid } from "../../../../src/schema/primitives/uuid.js";

describe("uuid", () => {
  it("returns valid v4 UUID unchanged (case-insensitive)", () => {
    const lower = "550e8400-e29b-41d4-a716-446655440000";
    const upper = "550E8400-E29B-41D4-A716-446655440000";
    expect(uuid(lower)).toBe(lower);
    expect(uuid(upper)).toBe(upper);
  });

  it("rejects non-v4 UUID (e.g. v1 with '1xxx')", () => {
    // Third group starts with 1 (v1) instead of 4 (v4)
    const v1 = "550e8400-e29b-11d4-a716-446655440000";
    expect(() => uuid(v1)).toThrow(`Expected UUID v4, got "${v1}"`);
  });

  it("throws 'Expected UUID v4' on malformed input", () => {
    expect(() => uuid("not-a-uuid")).toThrow('Expected UUID v4, got "not-a-uuid"');
    expect(() => uuid("")).toThrow('Expected UUID v4, got ""');
  });

  it("jsonSchema is { type: 'string', format: 'uuid' }", () => {
    expect(uuid.jsonSchema).toEqual({ type: "string", format: "uuid" });
  });
});
