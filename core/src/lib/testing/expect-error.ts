/** The test helper that checks a response is the one a given error class produces. */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareError } from "../errors/flare-error.js";
import type { FlareErrorClass } from "../errors/types.js";
import { wireNameOf } from "../errors/wire.js";

/**
 * The JSON body an error class's response carries.
 *
 * `message` and `detail` arrive only with a 4xx; for a 5xx class, which sends neither, `detail` is
 * undefined whatever the class declares.
 */
export type FlareErrorBody<E extends FlareError<JsonValue | undefined>> = {
  readonly error: string;
  readonly message?: string;
  readonly detail: E["detail"];
};

/**
 * Verifies that `res` is the response `errorClass` produces, its status and wire name, and returns its body.
 *
 * @throws {Error} When the status or wire name differs, naming the status and body that came back.
 *
 * @example
 * ```ts
 * const res = await app.fetch("POST /users", { body: { email: "ada@example.com" } });
 * const { detail } = await expectError(res, EmailTaken);
 * expect(detail.email).toBe("ada@example.com");
 * ```
 */
export async function expectError<E extends FlareError<JsonValue | undefined>>(
  res: Response,
  errorClass: FlareErrorClass<E>,
): Promise<FlareErrorBody<E>> {
  const name = wireNameOf(errorClass);
  const text = await res.text();
  let body: JsonValue = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the body stays the raw text, which the message below reports.
  }
  const named = typeof body === "object" && body !== null && !Array.isArray(body) && body["error"] === name;
  if (res.status !== errorClass.status || !named) {
    throw new Error(`Expected ${name} (${errorClass.status}), got ${res.status} ${text}`);
  }
  // Boundary after its check: the status and wire name match the class, whose detail type the body carries.
  return body as FlareErrorBody<E>;
}
