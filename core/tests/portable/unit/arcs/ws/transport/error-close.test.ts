/** Unit tests for closeForError and failureLogLevel: the close a socket sends when one of its handlers throws, and the level the failure logs at. */
import { describe, expect, it } from "vitest";
import { closeForError, failureLogLevel } from "../../../../../../src/lib/arcs/ws/transport/error-close.js";
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

  it("closes 1011 for a FlareError class whose status is outside 400-599 and that sets no closeCode", () => {
    class Moved extends FlareError {
      static override status = 302;
    }

    expect(closeForError(new Moved(), "Message handler failed")).toEqual({
      code: 1011,
      reason: "Message handler failed",
    });
  });

  it("trims a wire name past the 123-byte close reason limit, counting UTF-8 bytes", () => {
    class LongName extends ConflictError {
      static override code = "E".repeat(200);
    }
    class AccentedName extends ConflictError {
      static override code = "é".repeat(100);
    }

    expect(closeForError(new LongName(), "x").reason).toBe("E".repeat(123));
    // Each "é" is 2 UTF-8 bytes, so 61 of them (122 bytes) fit and a 62nd would not.
    expect(closeForError(new AccentedName(), "x").reason).toBe("é".repeat(61));
  });
});

describe("failureLogLevel", () => {
  it("logs a 4xx FlareError at warn, its own closeCode or not", () => {
    class RoomFull extends ConflictError {}
    class Kicked extends FlareError {
      static override status = 403;
      static override closeCode = 4100;
    }

    expect(failureLogLevel(new RoomFull())).toBe("warn");
    expect(failureLogLevel(new Kicked())).toBe("warn");
  });

  it("logs a 5xx FlareError and any other error at error", () => {
    expect(failureLogLevel(new ServiceUnavailableError("ledger down"))).toBe("error");
    expect(failureLogLevel(new Error("boom"))).toBe("error");
    expect(failureLogLevel("not an error")).toBe("error");
  });
});
