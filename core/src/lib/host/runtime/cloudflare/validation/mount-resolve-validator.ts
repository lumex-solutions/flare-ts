/**
 * Build-time validator for literal-trailing mounts lacking a resolver in the Cloudflare mount pipeline.
 */
import type { IValidator, ValidationError } from "../../../../validation/types.js";
import type { CfMountContext } from "./composite.js";

/**
 * Fails the build when a literal-trailing mount's Durable Object registered no `resolve(...)`.
 */
export class MountResolveValidator implements IValidator<CfMountContext> {
  validate(ctx: CfMountContext): ValidationError[] {
    return ctx.mounts
      .filter((m) => m.kind === "resolve")
      .filter((m) => !m.resolve)
      .map((m) => ({
        severity: "error" as const,
        code: "MOUNT_REQUIRES_RESOLVE",
        message: `Durable Object mount "${m.mountPath}" ends in a literal segment, `
          + `so ${m.cls.name}.resolve(...) must be registered to derive the instance.`,
        hint:
          `Call .resolve((ctx) => instanceName) (or the inject overload) on the host.durableObject(...) handle before host.build().`,
      }));
  }
}
