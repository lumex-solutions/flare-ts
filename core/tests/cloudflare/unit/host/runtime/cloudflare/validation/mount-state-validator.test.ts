/**
 * Unit tests for {@link MountStateValidator}: every state token a DO route consumes inbound must be
 * provably provided in the front-door context (token default/derivation, a global before-middleware's
 * provides, or the mount's resolve provides); output-only tokens need no provision.
 */
import { describe, expect, it } from "vitest";
import type { StateToken } from "../../../../../../../src/index.js";
import type { HttpArc } from "../../../../../../../src/lib/arcs/http/http-arc.js";
import type { FlareDurableObjectClass } from "../../../../../../../src/lib/host/runtime/cloudflare/do/durable-object.js";
import type { PendingMountRecord, ResolveRecord } from "../../../../../../../src/lib/host/runtime/cloudflare/router.js";
import type { CfMountContext } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/composite.js";
import { flareState } from "../../../../../../../src/index.js";
import { registerStateTokens } from "../../../../../../../src/lib/host/runtime/cloudflare/do/state-crossing.js";
import { MountStateValidator } from "../../../../../../../src/lib/host/runtime/cloudflare/validation/mount-state-validator.js";

/**
 * Builds a DO class carrying `static state` and interns its tokens, exactly as
 * host.durableObject() does at registration (staticStateTokens reads the interned registry).
 */
function fakeDoCls(name: string, state: readonly StateToken[]): FlareDurableObjectClass {
  const cls = class {
    static state = state;
  };
  Object.defineProperty(cls, "name", { value: name });
  const doCls = cls as unknown as FlareDurableObjectClass;
  registerStateTokens(doCls);
  return doCls;
}

/** A front-door arc fake carrying only what the validator reads: global middleware registrations. */
function fakeFrontDoor(middleware: Array<{ cls: unknown; }> = []): HttpArc<"sync"> {
  return { mwRegistrations: middleware } as unknown as HttpArc<"sync">;
}

function mountOf(cls: FlareDurableObjectClass, resolve?: ResolveRecord): PendingMountRecord {
  return resolve !== undefined
    ? { kind: "resolve", cls, mountPath: "/api/me", bindingName: cls.name, resolve }
    : { kind: "param", cls, mountPath: "/rooms/:name", bindingName: cls.name };
}

function makeCtx(
  mounts: PendingMountRecord[],
  consumedByClass: Map<FlareDurableObjectClass, Set<StateToken>>,
  frontDoor: HttpArc<"sync"> = fakeFrontDoor(),
): CfMountContext {
  return { mounts, frontDoor, frontDoorPatterns: [], groupPrefixes: [], consumedByClass };
}

describe("MountStateValidator", () => {
  it("reports MOUNT_STATE_NOT_PROVIDED when a consumed token has no provider anywhere", () => {
    const Token = flareState<string>("MountStateUnprovided");
    const cls = fakeDoCls("Room", [Token]);

    const errs = new MountStateValidator().validate(
      makeCtx([mountOf(cls)], new Map([[cls, new Set([Token])]])),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("MOUNT_STATE_NOT_PROVIDED");
    expect(errs[0]!.message).toContain("MountStateUnprovided");
    expect(errs[0]!.message).toContain('"/rooms/:name"');
  });

  it("an output-only token (declared but never consumed inbound) needs no provision", () => {
    const Token = flareState<string>("MountStateOutputOnly");
    const cls = fakeDoCls("Room", [Token]);

    const errs = new MountStateValidator().validate(
      makeCtx([mountOf(cls)], new Map([[cls, new Set<StateToken>()]])),
    );

    expect(errs).toEqual([]);
  });

  it("a token with a default self-provides", () => {
    const Token = flareState<string>("MountStateDefaulted").withDefault("fallback");
    const cls = fakeDoCls("Room", [Token]);

    const errs = new MountStateValidator().validate(
      makeCtx([mountOf(cls)], new Map([[cls, new Set<StateToken>([Token])]])),
    );

    expect(errs).toEqual([]);
  });

  it("a token with a derivation self-provides", () => {
    const Token = flareState<string>("MountStateDerived").from(() => "derived");
    const cls = fakeDoCls("Room", [Token]);

    const errs = new MountStateValidator().validate(
      makeCtx([mountOf(cls)], new Map([[cls, new Set<StateToken>([Token])]])),
    );

    expect(errs).toEqual([]);
  });

  it("a global before-middleware whose provides includes the token satisfies provision", () => {
    const Token = flareState<string>("MountStateMwProvided");
    const cls = fakeDoCls("Room", [Token]);

    class ProvidingMw {
      static provides = [Token];
      before(): void {}
    }
    const frontDoor = fakeFrontDoor([{ cls: ProvidingMw }]);

    const errs = new MountStateValidator().validate(
      makeCtx([mountOf(cls)], new Map([[cls, new Set([Token])]]), frontDoor),
    );

    expect(errs).toEqual([]);
  });

  it("a middleware with provides but NO before hook does not satisfy provision", () => {
    const Token = flareState<string>("MountStateAfterOnlyMw");
    const cls = fakeDoCls("Room", [Token]);

    class AfterOnlyMw {
      static provides = [Token];
      after(): void {}
    }
    const frontDoor = fakeFrontDoor([{ cls: AfterOnlyMw }]);

    const errs = new MountStateValidator().validate(
      makeCtx([mountOf(cls)], new Map([[cls, new Set([Token])]]), frontDoor),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("MOUNT_STATE_NOT_PROVIDED");
  });

  it("a token declared in the mount's resolve provides satisfies provision", () => {
    const Token = flareState<string>("MountStateResolveProvided");
    const cls = fakeDoCls("Room", [Token]);
    const resolve: ResolveRecord = { inject: {}, provides: [Token], handler: () => "x" };

    const errs = new MountStateValidator().validate(
      makeCtx([mountOf(cls, resolve)], new Map([[cls, new Set([Token])]])),
    );

    expect(errs).toEqual([]);
  });

  it("provision is checked per mount record: a DO mounted twice errors once per unsatisfied mount", () => {
    const Token = flareState<string>("MountStatePerMount");
    const cls = fakeDoCls("Room", [Token]);
    const provided: ResolveRecord = { inject: {}, provides: [Token], handler: () => "x" };

    const errs = new MountStateValidator().validate(
      makeCtx(
        [mountOf(cls), mountOf(cls, provided)],
        new Map([[cls, new Set([Token])]]),
      ),
    );

    // The param mount has no provider; the resolve mount provides through its resolver.
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('"/rooms/:name"');
  });
});
