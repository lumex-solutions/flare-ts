/**
 * Unit tests for {@link MountConflictValidator}: mounted subtrees are owned exclusively by their
 * Durable Object; overlap with front-door routes, group prefixes, or other mounts is a conflict.
 */
import { describe, expect, it } from "vitest";
import type { FlareDurableObjectClass } from "../../../../../../../src/lib/host/runtime/cloudflare/do/durable-object.js";
import type { PendingMountRecord } from "../../../../../../../src/lib/host/runtime/cloudflare/router.js";
import type { CfMountContext } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/composite.js";
import { MountConflictValidator } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/mount-conflict-validator.js";

/** The validator reads only cls.name off the class; a bare named class suffices. */
function fakeCls(name: string): FlareDurableObjectClass {
  const cls = class {};
  Object.defineProperty(cls, "name", { value: name });
  return cls as unknown as FlareDurableObjectClass;
}

function paramMount(cls: FlareDurableObjectClass, mountPath: string): PendingMountRecord {
  return { kind: "param", cls, mountPath, bindingName: cls.name };
}

function makeCtx(
  mounts: PendingMountRecord[],
  frontDoorPatterns: string[] = [],
  groupPrefixes: string[] = [],
): CfMountContext {
  return {
    mounts,
    frontDoor: { mwRegistrations: [] } as never,
    frontDoorPatterns,
    groupPrefixes,
    consumedByClass: new Map(),
  };
}

describe("mount vs front-door routes", () => {
  it("a front-door route inside the mounted subtree is a MOUNT_ROUTE_CONFLICT with a concrete example path", () => {
    const errs = new MountConflictValidator().validate(
      makeCtx([paramMount(fakeCls("Room"), "/rooms/:name")], ["/rooms/abc/settings"]),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("MOUNT_ROUTE_CONFLICT");
    expect(errs[0]!.message).toContain('both match "/rooms/abc/settings"');
  });

  it("a front-door route matching the bare mount path itself conflicts (param position matches any segment)", () => {
    const errs = new MountConflictValidator().validate(
      makeCtx([paramMount(fakeCls("Room"), "/rooms/:name")], ["/rooms/admin"]),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("MOUNT_ROUTE_CONFLICT");
  });

  it("a front-door route outside the subtree does not conflict", () => {
    const errs = new MountConflictValidator().validate(
      makeCtx([paramMount(fakeCls("Room"), "/rooms/:name")], ["/health", "/api/users/:id"]),
    );

    expect(errs).toEqual([]);
  });
});

describe("mount vs group prefixes", () => {
  it("a mount at or under a front-door group prefix conflicts (the group owns the subtree)", () => {
    const errs = new MountConflictValidator().validate(
      makeCtx([paramMount(fakeCls("Room"), "/api/rooms/:name")], [], ["/api"]),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("MOUNT_ROUTE_CONFLICT");
    expect(errs[0]!.message).toContain('group prefix "/api"');
  });

  it("a mount outside every group prefix does not conflict", () => {
    const errs = new MountConflictValidator().validate(
      makeCtx([paramMount(fakeCls("Room"), "/rooms/:name")], [], ["/api"]),
    );

    expect(errs).toEqual([]);
  });
});

describe("mount vs mount", () => {
  it("two mounts whose subtrees can match the same path conflict, reported once per unordered pair", () => {
    const errs = new MountConflictValidator().validate(
      makeCtx([
        paramMount(fakeCls("RoomA"), "/rooms/:name"),
        paramMount(fakeCls("RoomB"), "/rooms/admin"),
      ]),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("MOUNT_ROUTE_CONFLICT");
    expect(errs[0]!.message).toContain("/rooms/:name");
    expect(errs[0]!.message).toContain("/rooms/admin");
  });

  it("two mounts on disjoint subtrees do not conflict", () => {
    const errs = new MountConflictValidator().validate(
      makeCtx([
        paramMount(fakeCls("RoomA"), "/alpha/:name"),
        paramMount(fakeCls("RoomB"), "/beta/:name"),
      ]),
    );

    expect(errs).toEqual([]);
  });
});
