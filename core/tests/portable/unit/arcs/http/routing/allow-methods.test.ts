/** Unit tests for deriveAllowedMethods from registered handler slots. */
import { describe, expect, it } from "vitest";
import { deriveAllowedMethods } from "../../../../../../src/lib/arcs/http/routing/allow-methods.js";
import { METHOD_IDX_MAP } from "../../../../../../src/lib/arcs/http/routing/types/methods.js";

function handlersWith(...methods: string[]): Array<unknown | null> {
  const slots: Array<unknown | null> = Array(METHOD_IDX_MAP.OPTIONS + 1).fill(null);
  for (const method of methods) {
    slots[METHOD_IDX_MAP[method as keyof typeof METHOD_IDX_MAP]] = {};
  }
  return slots;
}

describe("deriveAllowedMethods", () => {
  it("lists methods in SUPPORTED_METHODS order and appends HEAD when GET is registered", () => {
    expect(deriveAllowedMethods(handlersWith("GET") as never)).toBe("GET, HEAD");
    expect(deriveAllowedMethods(handlersWith("POST") as never)).toBe("POST");
    expect(deriveAllowedMethods(handlersWith("GET", "POST", "DELETE") as never)).toBe(
      "GET, POST, DELETE, HEAD",
    );
    expect(deriveAllowedMethods(handlersWith("POST", "GET") as never)).toBe("GET, POST, HEAD");
  });

  it("includes OPTIONS only when includeOptions is true", () => {
    expect(deriveAllowedMethods(handlersWith("GET", "PUT") as never)).toBe("GET, PUT, HEAD");
    expect(deriveAllowedMethods(handlersWith("GET", "PUT") as never, { includeOptions: true })).toBe(
      "GET, PUT, HEAD, OPTIONS",
    );
  });

  it("does not duplicate HEAD when an explicit HEAD handler is registered", () => {
    expect(deriveAllowedMethods(handlersWith("GET", "HEAD") as never)).toBe("GET, HEAD");
    expect(deriveAllowedMethods(handlersWith("HEAD") as never)).toBe("HEAD");
  });
});
