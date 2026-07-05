/** Unit tests for WebSocket close code validation. */
import { describe, expect, it } from "vitest";
import { isValidCloseCode } from "../../../../../../../src/lib/arcs/ws/transport/wire/protocol.js";

describe("isValidCloseCode", () => {
  it("accepts the registered protocol codes", () => {
    for (const c of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011]) {
      expect(isValidCloseCode(c)).toBe(true);
    }
  });

  it("accepts the application range 3000-4999", () => {
    expect(isValidCloseCode(3000)).toBe(true);
    expect(isValidCloseCode(4999)).toBe(true);
  });

  it("rejects local-only and unassigned codes", () => {
    for (const c of [999, 1004, 1005, 1006, 1012, 1013, 1014, 1015, 2999, 5000]) {
      expect(isValidCloseCode(c)).toBe(false);
    }
  });
});
