/**
 * Unit tests for host internal symbol constants and unsafe config env key list.
 */
import { describe, it, expect } from "vitest";
import {
  SET_HOST_STATE,
  COMPILE_FOR_TEST,
  RESET_FOR_TEST,
  UNSAFE_CONFIG_ENV_KEYS,
} from "../../../../../src/lib/host/types/const.js";

describe("SET_HOST_STATE / COMPILE_FOR_TEST / RESET_FOR_TEST", () => {
  it("the three symbols are mutually distinct", () => {
    expect(SET_HOST_STATE).not.toBe(COMPILE_FOR_TEST);
    expect(SET_HOST_STATE).not.toBe(RESET_FOR_TEST);
    expect(COMPILE_FOR_TEST).not.toBe(RESET_FOR_TEST);

    const collected = new Set<symbol>([
      SET_HOST_STATE,
      COMPILE_FOR_TEST,
      RESET_FOR_TEST,
    ]);
    expect(collected.size).toBe(3);
  });

  it("symbol description matches the constant name (used for diagnostics)", () => {
    expect(SET_HOST_STATE.description).toBe("SET_HOST_STATE");
    expect(COMPILE_FOR_TEST.description).toBe("COMPILE_FOR_TEST");
    expect(RESET_FOR_TEST.description).toBe("RESET_FOR_TEST");
  });
});

describe("UNSAFE_CONFIG_ENV_KEYS", () => {
  it("contains exactly `__proto__`, `prototype`, `constructor`", () => {
    expect(UNSAFE_CONFIG_ENV_KEYS.size).toBe(3);
    expect([...UNSAFE_CONFIG_ENV_KEYS].sort()).toEqual(
      ["__proto__", "constructor", "prototype"],
    );
  });

  it('`.has("__proto__")`, `.has("prototype")`, `.has("constructor")` all true', () => {
    expect(UNSAFE_CONFIG_ENV_KEYS.has("__proto__")).toBe(true);
    expect(UNSAFE_CONFIG_ENV_KEYS.has("prototype")).toBe(true);
    expect(UNSAFE_CONFIG_ENV_KEYS.has("constructor")).toBe(true);
  });

  it('unrelated keys like `"toString"`, `"hasOwnProperty"` are not members', () => {
    expect(UNSAFE_CONFIG_ENV_KEYS.has("toString")).toBe(false);
    expect(UNSAFE_CONFIG_ENV_KEYS.has("hasOwnProperty")).toBe(false);
  });
});
