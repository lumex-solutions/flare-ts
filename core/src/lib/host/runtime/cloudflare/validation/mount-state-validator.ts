/**
 * Build-time validator for front-door state provision at Durable Object mounts in the Cloudflare mount pipeline.
 */
import type { StateToken } from "../../../../state/flare-state.js";
import type { IValidator, ValidationError } from "../../../../validation/types.js";
import type { CfMountContext } from "./composite.js";
import { getTokenDefault, getTokenDerivation } from "../../../../state/read.js";
import { staticStateTokens } from "../do/state-crossing.js";

/**
 * Front-door provide check (MOUNT_STATE_NOT_PROVIDED). For each mount record whose DO declares a
 * non-empty `static state`, every token a DO route actually CONSUMES inbound must be provably
 * provided in the front-door context before the forward. A token is provided iff:
 *   (a) it self-provides via a default or derivation (`getTokenDefault`/`getTokenDerivation`); OR
 *   (b) a front-door GLOBAL before-middleware's `provides` includes it; OR
 *   (c) it is declared in this mount's `resolve.provides`.
 *
 * Only CONSUMED tokens are checked: an output-only `static state` token (the DO sets it outbound,
 * no DO route requires it inbound, the front door never provides it) legitimately resolves to
 * nothing inbound and must build clean. A token consumed by a DO route but provided by nobody
 * front-door would throw the runtime `require` not-found inside the DO, so the check anchors to
 * exactly that consume set.
 *
 * Iterated per mount record: a DO mounted twice must satisfy provision at each mount path.
 */
export class MountStateValidator implements IValidator<CfMountContext> {
  validate(ctx: CfMountContext): ValidationError[] {
    // Case (b): tokens provided by any front-door global before-middleware.
    const mwProvided = new Set<StateToken>();
    for (const reg of ctx.frontDoor.mwRegistrations) {
      const cls = reg.cls as { prototype?: { before?: unknown; }; provides?: readonly StateToken[]; };
      if (!cls.prototype?.before) continue;
      for (const token of cls.provides ?? []) mwProvided.add(token);
    }

    const errors: ValidationError[] = [];
    for (const mount of ctx.mounts) {
      const tokens = staticStateTokens(mount.cls);
      if (tokens.length === 0) continue;
      const consumed = ctx.consumedByClass.get(mount.cls) ?? new Set<StateToken>();
      const resolveProvides = new Set<StateToken>(mount.resolve?.provides ?? []);
      for (const token of tokens) {
        if (!consumed.has(token)) continue; // output-only token: no inbound provision required.
        // The token list erases each token's builder typing; the reader helpers accept the typed view.
        const typed = token as Parameters<typeof getTokenDefault>[0];
        const selfProvides = getTokenDefault(typed) !== undefined || getTokenDerivation(typed) !== undefined;
        if (selfProvides || mwProvided.has(token) || resolveProvides.has(token)) continue;
        errors.push({
          severity: "error",
          code: "MOUNT_STATE_NOT_PROVIDED",
          message: `Durable Object ${mount.cls.name} mounted at "${mount.mountPath}" requires static state token `
            + `${token.name}, but nothing provides it in the front-door context before the forward.`,
          hint: `Give ${token.name} a .withDefault(...)/.from(...), provide it from a front-door before-middleware, `
            + `or declare it in this mount's resolve({ provides: [${token.name}] }, ...).`,
        });
      }
    }
    return errors;
  }
}
