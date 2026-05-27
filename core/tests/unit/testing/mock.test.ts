import { describe, it, expect } from "vitest";
import type { StateToken } from "../../../src/lib/arcs/http/state/types/state-token.js";
import type { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import type { ServiceToken } from "../../../src/lib/services/types/types.js";
import { FlareTestError } from "../../../src/lib/testing/error.js";
import { mockContainer, mockContext } from "../../../src/lib/testing/mock.js";

describe("mockContext", () => {
  it("copies only the view's bytes when body is a Uint8Array with a non-zero byteOffset", async () => {
    // Build a 10-byte backing buffer and a view over bytes 2..6 (4 bytes).
    const backing = new Uint8Array([0, 0, 1, 2, 3, 4, 0, 0, 0, 0]);
    const view = new Uint8Array(backing.buffer, 2, 4);

    const ctx = mockContext({ body: view });

    const raw = ctx.req.rawBody!;
    expect(raw).not.toBeNull();
    expect(raw.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(raw))).toEqual([1, 2, 3, 4]);
  });

  it("honors an explicit requestId override", () => {
    const ctx = mockContext({ requestId: "custom-req-id" });
    expect(ctx.req.requestId).toBe("custom-req-id");
  });

  it("uses 'mock-req' as the default requestId when none is provided", () => {
    const ctx = mockContext();
    expect(ctx.req.requestId).toBe("mock-req");
  });

  it("leaves headers empty when an empty headers object is passed", () => {
    const ctx = mockContext({ headers: {} });
    const seen: string[] = [];
    ctx.req.headers.forEach((_v, k) => seen.push(k));
    expect(seen).toEqual([]);
  });

  it("provides a non-aborted AbortSignal from the mock adapter", () => {
    const ctx = mockContext();
    expect(ctx.req.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.req.signal.aborted).toBe(false);
  });

  it("throws FlareTestError with index and type for an invalid state key (number)", () => {
    const goodToken: StateToken = { name: "Good" };
    const stateMap = new Map<StateToken, unknown>([
      [goodToken, "ok"],
      [42 as unknown as StateToken, "bad"],
    ]);

    expect(() => mockContext({ state: stateMap })).toThrow(FlareTestError);
    expect(() => mockContext({ state: stateMap })).toThrow(
      "mockContext received an invalid state key at index 1: expected a StateToken, got number",
    );
  });

  it("throws FlareTestError naming 'null' for a null state key", () => {
    const stateMap = new Map<StateToken, unknown>([
      [null as unknown as StateToken, "bad"],
    ]);

    expect(() => mockContext({ state: stateMap })).toThrow(
      "mockContext received an invalid state key at index 0: expected a StateToken, got null",
    );
  });

  it("throws FlareTestError for an object without a string .name property", () => {
    const stateMap = new Map<StateToken, unknown>([
      [{} as unknown as StateToken, "bad"],
    ]);

    expect(() => mockContext({ state: stateMap })).toThrow(
      "mockContext received an invalid state key at index 0: expected a StateToken, got object",
    );
  });
});

describe("mockContainer", () => {
  it("throws the framework registration error when resolving an unregistered token", () => {
    class UnregisteredToken {
      static deps: readonly ServiceToken<FlareService>[] = [];
    }

    const container = mockContainer(new Map());

    expect(() => container.resolveDep(UnregisteredToken as unknown as ServiceToken<FlareService>)).toThrow(
      "ServiceToken UnregisteredToken not registered in container.",
    );
  });
});
