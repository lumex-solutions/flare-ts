/**
 * The Cloudflare mount validation layer: the context shape mount validators inspect
 * and the composite factory that assembles them.
 */
import type { HttpArc } from "../../../../arcs/http/http-arc.js";
import type { StateToken } from "../../../../state/flare-state.js";
import type { FlareDurableObjectClass } from "../do/durable-object.js";
import type { PendingMountRecord } from "../router.js";
import { CompositeValidator } from "../../../../validation/composite-validator.js";
import { durableRegistration } from "../registration.js";
import { MountConflictValidator } from "./mount-conflict-validator.js";
import { MountResolveValidator } from "./mount-resolve-validator.js";
import { MountStateValidator } from "./mount-state-validator.js";

/**
 * Context passed to Cloudflare mount validators.
 *
 * Built by the adapter's mount build hook BEFORE any mount route installs, so the
 * validators see only developer-declared front-door routes.
 *
 * @internal
 */
export type CfMountContext = {
  /** Every mount record, with each DO's registered resolver attached where one exists. */
  readonly mounts: readonly PendingMountRecord[];
  readonly frontDoor: HttpArc<"sync">;
  /** Developer front-door route patterns plus front-door WS patterns. */
  readonly frontDoorPatterns: readonly string[];
  readonly groupPrefixes: readonly string[];
  /** Inbound-consumed state tokens per DO class (from each DO arc's controllers). */
  readonly consumedByClass: ReadonlyMap<FlareDurableObjectClass, ReadonlySet<StateToken>>;
};

/**
 * Builds the consumed-token set per DO class from its arc controllers' declared `state`.
 *
 * A context-building helper for the mount hook, not a validator itself.
 *
 * @internal
 */
export function consumedTokensByClass(
  durables: ReadonlyArray<FlareDurableObjectClass>,
): Map<FlareDurableObjectClass, Set<StateToken>> {
  const map = new Map<FlareDurableObjectClass, Set<StateToken>>();
  for (const cls of durables) {
    const arc = durableRegistration(cls)?.arc;
    if (!arc) continue;
    const consumed = new Set<StateToken>();
    const controllers = [...arc.conRegistrations, ...arc.groups.flatMap((g) => g.controllers)];
    for (const ctrl of controllers) {
      for (const token of (ctrl.cls as { state?: readonly StateToken[]; }).state ?? []) {
        consumed.add(token);
      }
    }
    map.set(cls, consumed);
  }
  return map;
}

/**
 * Creates the composite validator for the Cloudflare mount layer.
 *
 * Runs in order: missing resolvers -> subtree conflicts -> front-door state provision.
 * All validators run and collect their results; the build hook throws once with the
 * aggregate, before any mount route installs.
 */
export function createMountValidator(): CompositeValidator<CfMountContext> {
  return new CompositeValidator<CfMountContext>([
    new MountResolveValidator(),
    new MountConflictValidator(),
    new MountStateValidator(),
  ]);
}
