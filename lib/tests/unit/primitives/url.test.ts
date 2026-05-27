import { describe, expect, it } from "vitest";
import { url } from "../../../src/schema/primitives/url.js";

describe("url", () => {
  it("accepts https URL and normalizes", () => {
    expect(url("https://example.com")).toBe("https://example.com/");
  });

  it("accepts http URL", () => {
    expect(url("http://example.com")).toBe("http://example.com/");
  });

  it("preserves path", () => {
    expect(url("https://example.com/path/to/resource")).toBe("https://example.com/path/to/resource");
  });

  it("preserves query string", () => {
    expect(url("https://example.com/search?q=test")).toBe("https://example.com/search?q=test");
  });

  it("preserves port", () => {
    expect(url("https://example.com:8080/api")).toBe("https://example.com:8080/api");
  });

  it("lowercases scheme and host", () => {
    expect(url("HTTPS://EXAMPLE.COM/Path")).toBe("https://example.com/Path");
  });

  it("preserves fragment", () => {
    expect(url("https://example.com/page#section")).toBe("https://example.com/page#section");
  });

  it("accepts URL with auth credentials (passes through)", () => {
    // WHATWG URL preserves credentials in href — callers should strip if needed
    expect(url("https://user:pass@example.com")).toBe("https://user:pass@example.com/");
  });

  it("rejects ftp scheme", () => {
    expect(() => url("ftp://example.com")).toThrow('Expected http or https URL, got "ftp:"');
  });

  it("rejects file scheme", () => {
    expect(() => url("file:///etc/passwd")).toThrow('Expected http or https URL, got "file:"');
  });

  it("rejects javascript scheme", () => {
    expect(() => url("javascript:alert(1)")).toThrow('Expected http or https URL, got "javascript:"');
  });

  it("rejects data scheme", () => {
    expect(() => url("data:text/html,<h1>hi</h1>")).toThrow('Expected http or https URL, got "data:"');
  });

  it("rejects non-URL string", () => {
    expect(() => url("not a url")).toThrow('Expected URL, got "not a url"');
  });

  it("rejects empty string", () => {
    expect(() => url("")).toThrow('Expected URL, got ""');
  });

  it("rejects relative path", () => {
    expect(() => url("/path/to/resource")).toThrow('Expected URL, got "/path/to/resource"');
  });

  it("jsonSchema is { type: 'string', format: 'uri' }", () => {
    expect(url.jsonSchema).toEqual({ type: "string", format: "uri" });
  });

  it("_type is 'url'", () => {
    expect(url._type).toBe("url");
  });

  it("_required is true", () => {
    expect(url._required).toBe(true);
  });
});
