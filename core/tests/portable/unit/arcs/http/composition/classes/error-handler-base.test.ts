/**
 * Unit tests for ErrorHandlerBase handle() contract on a concrete subclass.
 */
import { describe, expect, it } from "vitest";
import type { HttpErrorContext } from "../../../../../../../src/lib/logger/types.js";
import { ErrorHandlerBase } from "../../../../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import { FlareResponse } from "../../../../../../../src/lib/arcs/http/transport/flare-response.js";
import { Container } from "../../../../../../../src/lib/services/container.js";

class TestErrorHandler extends ErrorHandlerBase {
  static override deps = [];

  override handle(_err: Error, _ctx: HttpErrorContext): FlareResponse {
    return new FlareResponse(500, { handled: true });
  }
}

describe("ErrorHandlerBase", () => {
  it("concrete subclass can implement handle() and return a ResponseLike", () => {
    const handler = new TestErrorHandler(new Container());
    // HttpErrorContext requires source, requestId, method, url - fill them
    // with placeholders for this isolated handler call.
    const res = handler.handle(new Error("boom"), {
      source: "flare:http",
      requestId: "test-req",
      method: "GET",
      url: "/test",
    });
    expect(res.status).toBe(500);
  });
});
