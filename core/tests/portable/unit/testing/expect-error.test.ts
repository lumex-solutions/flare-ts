/**
 * Unit tests for expectError: the body it returns for the response an error class produces, and what it
 * reports otherwise. Responses come from a real test host's routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../src/lib/testing/test-app-handle.js";
import { FlareResponse } from "../../../../src/lib/arcs/http/transport/flare-response.js";
import { ConflictError } from "../../../../src/lib/errors/conflict-error.js";
import { expectError } from "../../../../src/lib/testing/expect-error.js";
import { testHost } from "../../helpers/test-host.js";

class EmailTaken extends ConflictError<{ email: string; }> {}
class UsernameTaken extends ConflictError {}

let app: TestAppHandle;

beforeAll(async () => {
  const host = testHost();
  host.http.post("/signup", () => {
    throw new EmailTaken("ada@example.com is already registered", { detail: { email: "ada@example.com" } });
  });
  host.http.post("/rename", () => {
    throw new UsernameTaken("ada is taken");
  });
  host.http.get("/report", () => {
    throw new Error("report renderer crashed");
  });
  host.http.get("/teapot", () => new FlareResponse(409, new TextEncoder().encode("conflict")));
  app = await host.build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("expectError", () => {
  it("returns the body, typed by the error class, for a response the class produced", async () => {
    const body = await expectError(await app.fetch("POST /signup"), EmailTaken);

    expect(body.detail.email).toBe("ada@example.com");
    expect(body.message).toBe("ada@example.com is already registered");
  });

  it("reports the status and body that came back instead, for another status or wire name", async () => {
    await expect(expectError(await app.fetch("GET /report"), EmailTaken)).rejects.toThrow(
      'Expected EmailTaken (409), got 500 {"error":"Internal Server Error"}',
    );
    await expect(expectError(await app.fetch("POST /rename"), EmailTaken)).rejects.toThrow(
      'Expected EmailTaken (409), got 409 {"error":"UsernameTaken","message":"ada is taken"}',
    );
    await expect(expectError(await app.fetch("POST /signup"), UsernameTaken)).rejects.toThrow(
      "Expected UsernameTaken (409), got 409",
    );
  });

  it("reports a body that is not JSON as it came", async () => {
    await expect(expectError(await app.fetch("GET /teapot"), EmailTaken)).rejects.toThrow(
      "Expected EmailTaken (409), got 409 conflict",
    );
  });
});
