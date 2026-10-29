/** Unit tests for expectError: the body it returns for a matching response, and what it reports otherwise. */
import { describe, expect, it } from "vitest";
import { ConflictError } from "../../../../src/lib/errors/conflict-error.js";
import { expectError } from "../../../../src/lib/testing/expect-error.js";

class EmailTaken extends ConflictError<{ email: string; }> {}

function respond(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("expectError", () => {
  it("returns the body, typed by the error class, for a response the class produced", async () => {
    const res = respond(
      409,
      JSON.stringify({ error: "EmailTaken", message: "taken", detail: { email: "ada@example.com" } }),
    );

    const body = await expectError(res, EmailTaken);

    expect(body.detail.email).toBe("ada@example.com");
  });

  it("reports the status and body that came back instead, for another status or wire name", async () => {
    await expect(expectError(respond(500, '{"error":"Internal Server Error"}'), EmailTaken)).rejects.toThrow(
      'Expected EmailTaken (409), got 500 {"error":"Internal Server Error"}',
    );
    await expect(expectError(respond(409, '{"error":"UsernameTaken"}'), EmailTaken)).rejects.toThrow(
      'Expected EmailTaken (409), got 409 {"error":"UsernameTaken"}',
    );
    await expect(expectError(respond(400, '{"error":"EmailTaken"}'), EmailTaken)).rejects.toThrow(
      'Expected EmailTaken (409), got 400 {"error":"EmailTaken"}',
    );
  });

  it("reports a body that is not JSON as it came", async () => {
    await expect(expectError(respond(409, "conflict"), EmailTaken)).rejects.toThrow(
      "Expected EmailTaken (409), got 409 conflict",
    );
  });
});
