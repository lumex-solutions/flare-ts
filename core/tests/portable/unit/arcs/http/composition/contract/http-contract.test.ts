/**
 * Unit tests for httpContract branding and descriptor passthrough.
 */
import { describe, it, expect } from "vitest";
import { stream } from "../../../../../../../src/index.js";
import { httpContract } from "../../../../../../../src/lib/arcs/http/composition/contract/http-contract.js";
import { CONTRACT_BRAND } from "../../../../../../../src/lib/contract/contract.js";

describe("httpContract", () => {
  it("returns an object branded with CONTRACT_BRAND set to the 'http' kind", () => {
    const contract = httpContract({});

    expect(contract[CONTRACT_BRAND]).toBe("http");
  });

  it("spreads all descriptor keys onto the returned object verbatim", () => {
    const getUser = {
      route: {},
      response: {},
    };
    const createUser = {
      body: undefined,
      maxBodyBytes: 1024,
    };
    const descriptor = { getUser, createUser };

    // The literal `body: undefined` violates exactOptionalPropertyTypes against
    // RequestDescriptor's optional `body?` field. The test exercises that
    // httpContract preserves the raw descriptor verbatim, so we cast the
    // input to bypass the strict check and re-cast the result to access the
    // surfaced keys.
    const contract = httpContract(descriptor as never) as unknown as typeof descriptor & { [CONTRACT_BRAND]: "http"; };

    expect(contract.getUser).toBe(getUser);
    expect(contract.createUser).toBe(createUser);
    expect(contract.getUser).toEqual({ route: {}, response: {} });
    expect(contract.createUser).toEqual({ body: undefined, maxBodyBytes: 1024 });
  });

  it("empty descriptor still produces a branded token", () => {
    const contract = httpContract({});

    expect(contract[CONTRACT_BRAND]).toBe("http");
    expect(Object.keys(contract)).toEqual([]);
  });
});

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
