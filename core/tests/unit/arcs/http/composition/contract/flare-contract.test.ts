import { describe, it, expect } from "vitest";
import {
  CONTRACT_BRAND,
  flareContract,
} from "../../../../../../src/lib/arcs/http/composition/contract/flare-contract.js";

describe("flareContract", () => {
  it("returns an object branded with CONTRACT_BRAND set to true", () => {
    const contract = flareContract({});

    expect(contract[CONTRACT_BRAND]).toBe(true);
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
    // flareContract preserves the raw descriptor verbatim, so we cast the
    // input to bypass the strict check and re-cast the result to access the
    // surfaced keys.
    const contract = flareContract(descriptor as never) as unknown as typeof descriptor & { [CONTRACT_BRAND]: true; };

    expect(contract.getUser).toBe(getUser);
    expect(contract.createUser).toBe(createUser);
    expect(contract.getUser).toEqual({ route: {}, response: {} });
    expect(contract.createUser).toEqual({ body: undefined, maxBodyBytes: 1024 });
  });

  it("empty descriptor still produces a branded token", () => {
    const contract = flareContract({});

    expect(contract[CONTRACT_BRAND]).toBe(true);
    expect(Object.keys(contract)).toEqual([]);
  });
});
