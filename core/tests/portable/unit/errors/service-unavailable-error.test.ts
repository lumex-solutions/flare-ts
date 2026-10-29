/** Unit tests for ServiceUnavailableError: its status, thrown directly and inherited by a domain error. */
import { describe, expect, it } from "vitest";
import { ServiceUnavailableError } from "../../../../src/lib/errors/service-unavailable-error.js";

describe("ServiceUnavailableError", () => {
  it("has status 503, named ServiceUnavailableError when thrown directly", () => {
    const err = new ServiceUnavailableError("Ledger unreachable");

    expect([err.status, err.name]).toEqual([503, "ServiceUnavailableError"]);
  });

  it("passes status 503 to a domain error that extends it, under the domain error's name", () => {
    class LedgerOffline extends ServiceUnavailableError {}
    const err = new LedgerOffline("Ledger unreachable");

    expect([err.status, err.name]).toEqual([503, "LedgerOffline"]);
  });
});
