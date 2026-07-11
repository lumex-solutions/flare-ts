/**
 * Unit tests for {@link MountResolveValidator}: literal-trailing mounts must carry a resolver.
 */
import { describe, expect, it } from "vitest";
import type { FlareDurableObjectClass } from "../../../../../../../src/lib/host/runtime/cloudflare/do/durable-object.js";
import type { PendingMountRecord, ResolveRecord } from "../../../../../../../src/lib/host/runtime/cloudflare/router.js";
import type { CfMountContext } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/composite.js";
import { MountResolveValidator } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/mount-resolve-validator.js";

/** The validator reads only cls.name off the class; a bare named class suffices. */
function fakeCls(name: string): FlareDurableObjectClass {
  const cls = class {};
  Object.defineProperty(cls, "name", { value: name });
  return cls as unknown as FlareDurableObjectClass;
}

function makeCtx(mounts: PendingMountRecord[]): CfMountContext {
  return {
    mounts,
    frontDoor: { mwRegistrations: [] } as never,
    frontDoorPatterns: [],
    groupPrefixes: [],
    consumedByClass: new Map(),
  };
}

const someResolver: ResolveRecord = { inject: {}, provides: [], handler: () => "x" };

describe("MountResolveValidator", () => {
  it("reports MOUNT_REQUIRES_RESOLVE for a literal-trailing mount whose resolver is still null", () => {
    const errs = new MountResolveValidator().validate(makeCtx([
      { kind: "resolve", cls: fakeCls("Room"), mountPath: "/api/me", bindingName: "Room", resolve: null },
    ]));

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("MOUNT_REQUIRES_RESOLVE");
    expect(errs[0]!.message).toContain("/api/me");
    expect(errs[0]!.message).toContain("Room.resolve(");
  });

  it("returns [] when the literal-trailing mount has its resolver attached", () => {
    const errs = new MountResolveValidator().validate(makeCtx([
      { kind: "resolve", cls: fakeCls("Room"), mountPath: "/api/me", bindingName: "Room", resolve: someResolver },
    ]));

    expect(errs).toEqual([]);
  });

  it("returns [] for a param-trailing mount (the trailing param names the instance; no resolver needed)", () => {
    const errs = new MountResolveValidator().validate(makeCtx([
      { kind: "param", cls: fakeCls("Room"), mountPath: "/rooms/:name", bindingName: "Room" },
    ]));

    expect(errs).toEqual([]);
  });

  it("reports one error per unresolved literal mount (a DO mounted twice needs each satisfied)", () => {
    const cls = fakeCls("Room");
    const errs = new MountResolveValidator().validate(makeCtx([
      { kind: "resolve", cls, mountPath: "/api/me", bindingName: "Room", resolve: null },
      { kind: "resolve", cls, mountPath: "/api/coordinator", bindingName: "Room", resolve: null },
    ]));

    expect(errs).toHaveLength(2);
  });
});
