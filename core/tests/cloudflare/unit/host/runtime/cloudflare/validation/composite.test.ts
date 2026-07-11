/**
 * Unit tests for the Cloudflare mount composite: one aggregated pass collects resolver,
 * conflict, and state-provision errors together, in that order.
 */
import { describe, expect, it } from "vitest";
import type { StateToken } from "../../../../../../../src/index.js";
import type { HttpArc } from "../../../../../../../src/lib/arcs/http/http-arc.js";
import type { FlareDurableObjectClass } from "../../../../../../../src/lib/host/runtime/cloudflare/do/durable-object.js";
import type { CfMountContext } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/composite.js";
import { flareState } from "../../../../../../../src/index.js";
import { registerStateTokens } from "../../../../../../../src/lib/host/runtime/cloudflare/do/state-crossing.js";
import { createMountValidator } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/composite.js";

describe("createMountValidator", () => {
  it("collects MOUNT_REQUIRES_RESOLVE, MOUNT_ROUTE_CONFLICT, and MOUNT_STATE_NOT_PROVIDED in one pass, in order", () => {
    const Token = flareState<string>("MountCompositeToken");
    const cls = class {
      static state = [Token];
    } as unknown as FlareDurableObjectClass;
    Object.defineProperty(cls, "name", { value: "Room" });
    registerStateTokens(cls);

    const ctx: CfMountContext = {
      mounts: [
        // Literal-trailing with no resolver AND consuming an unprovided token.
        { kind: "resolve", cls, mountPath: "/api/me", bindingName: "Room", resolve: null },
      ],
      frontDoor: { mwRegistrations: [] } as unknown as HttpArc<"sync">,
      // A front-door route inside the mounted subtree.
      frontDoorPatterns: ["/api/me/settings"],
      groupPrefixes: [],
      consumedByClass: new Map([[cls, new Set<StateToken>([Token])]]),
    };

    const codes = createMountValidator().validate(ctx).map((e) => e.code);
    expect(codes).toEqual(["MOUNT_REQUIRES_RESOLVE", "MOUNT_ROUTE_CONFLICT", "MOUNT_STATE_NOT_PROVIDED"]);
  });
});
