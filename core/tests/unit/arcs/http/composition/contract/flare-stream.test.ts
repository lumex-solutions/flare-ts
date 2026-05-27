import { describe, it, expect } from "vitest";
import { stream } from "../../../../../../src/lib/arcs/http/composition/contract/flare-stream.js";

describe("stream", () => {
  it('returns the literal "stream" regardless of input', () => {
    expect(stream("")).toBe("stream");
    expect(stream("anything")).toBe("stream");
    expect(stream("application/octet-stream")).toBe("stream");
  });

  it('has _type = "stream", _required = true, jsonSchema = {} properties', () => {
    expect(stream._type).toBe("stream");
    expect(stream._required).toBe(true);
    expect(stream.jsonSchema).toEqual({});
  });
});
