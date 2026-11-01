/**
 * Integration tests for FlareError responses: a route that throws one answers with its class's status
 * and wire name, plus the message and detail on a 4xx, through a real app's default error path; the
 * log record carries the error's cause chain, at warn for a 4xx FlareError and at error otherwise.
 * Uses in-process `app.test()` with a recording log transport; transport framing is not the claim.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../../../../../src/index.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import {
  ConflictError,
  FlareError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
} from "../../../../../src/errors.js";
import { LoggerTransport } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "recording";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];

  override write(record: LogRecord): void {
    RecordingTransport.records.push(record);
  }
}

class UserNotFound extends NotFoundError {}

class EmailTaken extends ConflictError<{ email: string; }> {
  constructor(email: string) {
    super(`${email} is already registered`, { detail: { email } });
  }
}

class LedgerOffline extends ServiceUnavailableError {}

class PlanLimitReached extends FlareError {
  static override status = 402;
  static override code = "PLAN_LIMIT_REACHED";
}

let app: TestAppHandle;

beforeAll(async () => {
  const host = testHost({ log: { level: "info" } });
  host.logging.transport(RecordingTransport);
  host.http.get("/users/:id", () => {
    throw new UserNotFound("User u_42 not found");
  });
  host.http.post("/users", () => {
    throw new EmailTaken("ada@example.com");
  });
  host.http.get("/ledger", () => {
    throw new LedgerOffline("Ledger unreachable", { cause: new Error("connect ECONNREFUSED") });
  });
  host.http.post("/login", () => {
    throw new RateLimitedError(30, "Too many login attempts");
  });
  host.http.post("/projects", () => {
    throw new PlanLimitReached("Upgrade to add more projects");
  });
  host.http.get("/report", () => {
    throw new Error("report renderer crashed");
  });
  app = await host.build().test();
});

afterAll(async () => {
  await app.stop();
});

beforeEach(() => {
  RecordingTransport.records.length = 0;
});

describe("Primary Behavior", () => {
  it("answers a thrown 4xx error with its status, wire name, and message", async () => {
    const res = await app.fetch("GET /users/u_42");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "UserNotFound", message: "User u_42 not found" });
  });

  it("sends a 4xx error's typed detail to the client", async () => {
    const res = await app.fetch("POST /users");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "EmailTaken",
      message: "ada@example.com is already registered",
      detail: { email: "ada@example.com" },
    });
  });

  it("answers a thrown 5xx error with its status and wire name only", async () => {
    const res = await app.fetch("GET /ledger");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "LedgerOffline" });
  });

  it("sends the headers an error carries", async () => {
    const res = await app.fetch("POST /login");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("uses a class's static code as the wire name", async () => {
    const res = await app.fetch("POST /projects");

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "PLAN_LIMIT_REACHED", message: "Upgrade to add more projects" });
  });

  it("answers an error that is not a FlareError with a bare 500", async () => {
    const res = await app.fetch("GET /report");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
  });
});

describe("Logging", () => {
  it("logs the unhandled error with its cause chain", async () => {
    await app.fetch("GET /ledger");

    const logged = RecordingTransport.records.find((record) => record.message === "Unhandled error");
    expect(logged?.level).toBe("error");
    expect(logged?.error).toMatchObject({
      name: "LedgerOffline",
      message: "Ledger unreachable",
      cause: { name: "Error", message: "connect ECONNREFUSED" },
    });
  });

  it("logs a 4xx FlareError at warn, with its status", async () => {
    await app.fetch("POST /users");

    expect(RecordingTransport.records.map((record) => record.message)).not.toContain("Unhandled error");
    const logged = RecordingTransport.records.find((record) => record.message === "Request failed with a 4xx error");
    expect(logged?.level).toBe("warn");
    expect(logged?.meta).toMatchObject({
      status: 409,
      error: { name: "EmailTaken", message: "ada@example.com is already registered" },
    });
  });

  it("logs an error that is not a FlareError at error", async () => {
    await app.fetch("GET /report");

    const logged = RecordingTransport.records.find((record) => record.message === "Unhandled error");
    expect(logged?.level).toBe("error");
    expect(logged?.error).toMatchObject({ name: "Error", message: "report renderer crashed" });
  });
});
