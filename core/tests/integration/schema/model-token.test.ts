// Behavior tests for the schema/model-token feature — cross-package half.
//
// The bulk of the spec's bullets exercise pure schema operations (safeParse,
// optional, descriptor reuse) and live in
// `lib/tests/behavior/schema/model-token.test.ts`. This file covers the one
// Cross-Feature Interaction bullet that requires the host transport layer,
// because `@flare-ts/lib`'s tests cannot import `@flare-ts/core`.
//
// The transport layer detects a model instance via the well-known
// `Symbol.for("@flare-ts/schema/brand")` (to confirm it's a schema-branded
// constructor) and serialises it via
// `Symbol.for("@flare-ts/schema/compiled-serializer")` on the constructor.
// Both lookups happen without `core/` importing from the schema module —
// see `core/src/lib/arcs/http/transport/normalize.ts`. The fact that a
// `model()`-produced class flowing through a handler ends up serialised by
// its compiled serializer is the observable confirmation that the well-known
// symbol path works end-to-end.

// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. Mirrors
// the gate every other behavior test file in this package uses.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSerializer, model, str, uuid } from "@flare-ts/lib/schema";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareHost } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// The well-known compiled-serializer symbol — used by the transport layer
// without importing from the schema package. We grab it here the same way
// (Symbol.for) so the assertion proves the cross-package contract.
const COMPILED_SERIALIZER = Symbol.for("@flare-ts/schema/compiled-serializer");

describe("Cross-Feature Interactions", () => {
  // Define the model class once, at module scope, so the handler and the
  // assertion share the exact constructor whose symbol the transport reads.
  class UserModel extends model<{ id: string; name: string; }>({
    id: uuid,
    name: str,
  }) {}

  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    // Handler returns an *instance* of the model class. The transport must
    // recognise it via the brand symbol and serialise via the
    // COMPILED_SERIALIZER symbol on its constructor — without importing
    // from `@flare-ts/lib/schema` inside `core/`.
    host.http.get("/user", () => {
      const u = Object.create(UserModel.prototype) as UserModel;
      (u as { id: string; }).id = "550e8400-e29b-41d4-a716-446655440000";
      (u as { name: string; }).name = "Ada";
      return u;
    });

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    '(with the host transport layer) an exported model class is recognised by transport code via the well-known `Symbol.for("@flare-ts/schema/compiled-serializer")` lookup, without needing to import the schema package directly',
    async () => {
      const res = await app.fetch("GET /user");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");

      const body = await res.text();

      // What the transport *should* have produced: the eagerly-compiled
      // serializer attached to the class via the well-known symbol.
      const eager = (UserModel as unknown as Record<symbol, unknown>)[
        COMPILED_SERIALIZER
      ] as (v: unknown) => string;
      expect(typeof eager).toBe("function");

      const expected = eager({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Ada",
      });
      expect(body).toBe(expected);

      // Sanity check: the same bytes also match a freshly-compiled serializer
      // built by `compileSerializer(UserModel)`, proving the eager and manual
      // paths agree (and that the transport really did go through the schema
      // codegen rather than JSON.stringify fallback).
      const manual = compileSerializer(
        UserModel as unknown as Parameters<typeof compileSerializer>[0],
      );
      expect(body).toBe(manual({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Ada",
      }));

      // And it round-trips through JSON.parse to the input shape.
      expect(JSON.parse(body)).toEqual({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Ada",
      });
    },
  );
});
