/**
 * Unit tests for the WebSocketRefusal verdict value: construction-time validation of the sendable code
 * set and the wire's close-reason byte limit.
 */
import { describe, expect, it } from "vitest";
import { WebSocketRefusal } from "../../../../../../src/lib/arcs/ws/transport/web-socket-refusal.js";

describe("WebSocketRefusal", () => {
  it("accepts 1000 and the application code range", () => {
    expect(new WebSocketRefusal(1000).code).toBe(1000);
    expect(new WebSocketRefusal(3000).code).toBe(3000);
    expect(new WebSocketRefusal(4999, "bye").reason).toBe("bye");
  });

  it("rejects protocol-range and out-of-range codes", () => {
    expect(() => new WebSocketRefusal(1006)).toThrow(/1000 or an application code/);
    expect(() => new WebSocketRefusal(2999)).toThrow(/1000 or an application code/);
    expect(() => new WebSocketRefusal(5000)).toThrow(/1000 or an application code/);
    expect(() => new WebSocketRefusal(4302.5)).toThrow(/1000 or an application code/);
  });

  it("enforces the 123-BYTE reason cap (UTF-8 bytes, not characters)", () => {
    expect(new WebSocketRefusal(4302, "x".repeat(123)).reason).toHaveLength(123);
    expect(() => new WebSocketRefusal(4302, "x".repeat(124))).toThrow(/123-byte/);
    // 62 two-byte characters = 124 bytes: over the wire limit despite only 62 characters.
    expect(() => new WebSocketRefusal(4302, "é".repeat(62))).toThrow(/123-byte/);
  });
});
