import type { TypedPrimitive } from "@flare-ts/lib/schema";

/**
 * Stream primitive. Marks a contract descriptor body field as a stream.
 *
 * TODO(stream-export): Decide whether `stream` belongs on the public `@flare-ts/core`
 * export surface (alongside `str`, `int`, etc.) or stays internal-only. Runtime
 * support exists; docs currently tell app authors to use `ctx.req.stream()` without
 * a stream contract until this is resolved.
 */
const stream: TypedPrimitive<"stream"> = Object.assign((v: string): "stream" => "stream", {
  _type: "stream",
  _required: true,
  jsonSchema: {},
});

export { stream };
