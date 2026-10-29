/** Unit tests for closeForError: the close code and reason a socket sends when one of its handlers throws. */
import { describe, expect, it } from "vitest";
import { closeForError } from "../../../../../../src/lib/arcs/ws/transport/error-close.js";
import { ConflictError } from "../../../../../../src/lib/errors/conflict-error.js";
import { FlareError } from "../../../../../../src/lib/errors/flare-error.js";
import { ServiceUnavailableError } from "../../../../../../src/lib/errors/service-unavailable-error.js";

describe("closeForError", () => {
  it("closes a 4xx FlareError with 4000 + status and its wire name as the reason", () => {
    class RoomFull extends ConflictError {}

    expect(closeForError(new RoomFull("Room r_9 is full"), "Message handler failed")).toEqual({
      code: 4409,
      reason: "RoomFull",
    });
  });

  it("closes with the class's static closeCode when it sets one in range, and ignores one out of range", () => {
    class Kicked extends FlareError {
      static override status = 403;
      static override closeCode = 4100;
    }
    class BadCode extends ConflictError {
      static override closeCode = 1000;
    }

    expect(closeForError(new Kicked(), "x")).toEqual({ code: 4100, reason: "Kicked" });
    expect(closeForError(new BadCode(), "x")).toEqual({ code: 4409, reason: "BadCode" });
  });

  it("closes a 5xx FlareError and any other error with 1011 and the fallback reason", () => {
    expect(closeForError(new ServiceUnavailableError("ledger down"), "Message handler failed")).toEqual({
      code: 1011,
      reason: "Message handler failed",
    });
    expect(closeForError(new Error("boom"), "Connection setup failed")).toEqual({
      code: 1011,
      reason: "Connection setup failed",
    });
  });

  it("trims a wire name past the 123-byte close reason limit", () => {
    class LongName extends ConflictError {
      static override code = "E".repeat(200);
    }

    expect(closeForError(new LongName(), "x").reason).toBe("E".repeat(123));
  });
});
