import { describe, expect, it } from "vitest";
import { email } from "../../../src/schema/primitives/email.js";

describe("email", () => {
  it("accepts a valid email and lowercases it", () => {
    expect(email("user@example.com")).toBe("user@example.com");
    expect(email("User@Example.COM")).toBe("user@example.com");
  });

  it("accepts emails with plus addressing", () => {
    expect(email("user+tag@example.com")).toBe("user+tag@example.com");
  });

  it("accepts emails with dots in local part", () => {
    expect(email("first.last@example.com")).toBe("first.last@example.com");
  });

  it("accepts emails with subdomains", () => {
    expect(email("user@mail.example.co.uk")).toBe("user@mail.example.co.uk");
  });

  it("accepts user@localhost (no TLD required)", () => {
    expect(email("user@localhost")).toBe("user@localhost");
  });

  it("rejects missing @ sign", () => {
    expect(() => email("userexample.com")).toThrow('Expected email address, got "userexample.com"');
  });

  it("rejects missing domain", () => {
    expect(() => email("user@")).toThrow('Expected email address, got "user@"');
  });

  it("rejects missing local part", () => {
    expect(() => email("@example.com")).toThrow('Expected email address, got "@example.com"');
  });

  it("rejects empty string", () => {
    expect(() => email("")).toThrow('Expected email address, got ""');
  });

  it("rejects spaces", () => {
    expect(() => email("user @example.com")).toThrow("Expected email address");
  });

  it("rejects multiple @ signs", () => {
    expect(() => email("user@@example.com")).toThrow("Expected email address");
  });

  it("rejects newlines in input", () => {
    expect(() => email("user@example.com\n")).toThrow("Expected email address");
  });

  it("jsonSchema is { type: 'string', format: 'email' }", () => {
    expect(email.jsonSchema).toEqual({ type: "string", format: "email" });
  });

  it("_type is 'email'", () => {
    expect(email._type).toBe("email");
  });

  it("_required is true", () => {
    expect(email._required).toBe(true);
  });
});
