import { describe, expect, it } from "vitest";
import {
  INVALID_REQUEST_PATH_BODY,
  isValidInboundPath,
} from "../../../../../src/lib/arcs/http/routing/request-path.js";

describe("isValidInboundPath", () => {
  it("accepts root and normal paths", () => {
    expect(isValidInboundPath("/")).toBe(true);
    expect(isValidInboundPath("/users")).toBe(true);
    expect(isValidInboundPath("/users/42")).toBe(true);
  });

  it("rejects trailing slashes except root", () => {
    expect(isValidInboundPath("/users/")).toBe(false);
    expect(isValidInboundPath("/api/v1/")).toBe(false);
  });

  it("rejects empty segments (double slashes)", () => {
    expect(isValidInboundPath("//users")).toBe(false);
    expect(isValidInboundPath("/users//42")).toBe(false);
    expect(isValidInboundPath("/a//b/c")).toBe(false);
  });

  it("rejects paths that do not start with /", () => {
    expect(isValidInboundPath("users")).toBe(false);
    expect(isValidInboundPath("")).toBe(false);
  });
});

describe("INVALID_REQUEST_PATH_BODY", () => {
  it("documents the client-facing 400 shape", () => {
    expect(INVALID_REQUEST_PATH_BODY.error).toMatch(/start with "\/"/);
    expect(INVALID_REQUEST_PATH_BODY.error).toMatch(/trailing slash/);
    expect(INVALID_REQUEST_PATH_BODY.error).toMatch(/empty segment/);
  });
});
