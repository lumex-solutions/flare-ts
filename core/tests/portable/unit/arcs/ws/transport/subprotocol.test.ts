/** Unit tests for WebSocket subprotocol negotiation via pickSubprotocol. */
import { describe, expect, it } from "vitest";
import { pickSubprotocol } from "../../../../../../src/lib/arcs/ws/transport/subprotocol.js";

describe("pickSubprotocol", () => {
  it("returns the first client-offered token the endpoint accepts (client preference)", () => {
    expect(pickSubprotocol("chat.v2, chat.v1", ["chat.v1", "chat.v2"])).toBe("chat.v2");
  });

  it("trims whitespace around offered tokens", () => {
    expect(pickSubprotocol("  a ,  b ", ["b"])).toBe("b");
  });

  it("returns empty string when nothing matches", () => {
    expect(pickSubprotocol("a, b", ["c"])).toBe("");
  });

  it("returns empty string for a missing or empty offer", () => {
    expect(pickSubprotocol(undefined, ["a"])).toBe("");
    expect(pickSubprotocol(null, ["a"])).toBe("");
    expect(pickSubprotocol("", ["a"])).toBe("");
  });

  it("returns empty string when the endpoint accepts nothing", () => {
    expect(pickSubprotocol("a", [])).toBe("");
  });

  it("ignores an offer list longer than the token cap (DoS bound)", () => {
    const offered = Array.from({ length: 65 }, (_, i) => `p${i}`).join(",");
    expect(pickSubprotocol(`${offered},target`, ["target"])).toBe("");
    // At the cap it still works.
    const atCap = Array.from({ length: 63 }, (_, i) => `p${i}`).join(",");
    expect(pickSubprotocol(`${atCap},target`, ["target"])).toBe("target");
  });

  it("does not let a __proto__ token collide with Object.prototype", () => {
    // Offered but not accepted: must not match via the prototype chain.
    expect(pickSubprotocol("__proto__", ["chat"])).toBe("");
    // Explicitly accepted: matches as a real token.
    expect(pickSubprotocol("__proto__", ["__proto__"])).toBe("__proto__");
  });
});
