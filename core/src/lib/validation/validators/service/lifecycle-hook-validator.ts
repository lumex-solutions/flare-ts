import type { ServiceValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";
import { ControllerBase } from "../../../arcs/http/composition/classes/controller-base.js";
import { MiddlewareBase } from "../../../arcs/http/composition/classes/middleware-base.js";
import { FlareService } from "../../../services/composition/flare-service.js";

const LIFECYCLE_HOOKS = ["onStart", "onStop", "dispose"] as const;
type LifecycleHook = (typeof LIFECYCLE_HOOKS)[number];

/**
 * Validates that lifecycle hooks are used on the correct service lifetime:
 * - onStart / onStop  -> singletons only
 * - dispose           -> scoped services only
 * - no hooks allowed  -> controllers and middleware (always per-request)
 *
 * Also catches contradictory combinations (both onStart and dispose on the same class).
 */
export class LifecycleHookValidator implements IValidator<ServiceValidationContext> {
  /**
   * Reports `CONTRADICTORY_LIFECYCLE_HOOKS`, `INVALID_LIFECYCLE_HOOK`,
   * `CONTROLLER_LIFECYCLE_HOOK`, and `MIDDLEWARE_LIFECYCLE_HOOK` for
   * lifetime/hook combinations that are not allowed by the service model.
   */
  validate(ctx: ServiceValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const reg of ctx.scoped) {
      const proto = reg.cls.prototype;
      const hasOnStart = hasHook(proto, "onStart", FlareService.prototype);
      const hasOnStop = hasHook(proto, "onStop", FlareService.prototype);
      const hasDispose = hasHook(proto, "dispose", FlareService.prototype);

      if ((hasOnStart || hasOnStop) && hasDispose) {
        errors.push({
          severity: "error",
          code: "CONTRADICTORY_LIFECYCLE_HOOKS",
          message:
            `${reg.cls.name} defines both onStart()/onStop() and dispose(): these are contradictory lifetime signals.`,
          hint:
            `onStart/onStop imply singleton lifetime; dispose() implies scoped lifetime. Choose one or register via host.singleton().`,
        });
      } else if (hasOnStart || hasOnStop) {
        const hooks = hasOnStart && hasOnStop ? "onStart() and onStop()" : hasOnStart ? "onStart()" : "onStop()";
        errors.push({
          severity: "error",
          code: "INVALID_LIFECYCLE_HOOK",
          message:
            `${reg.cls.name} defines ${hooks} but is registered via host.scoped(). These hooks are only valid for singletons.`,
          hint: `Use host.singleton() or remove the hook.`,
        });
      }
    }

    for (const reg of ctx.singletons) {
      const proto = reg.cls.prototype;
      const hasOnStart = hasHook(proto, "onStart", FlareService.prototype);
      const hasOnStop = hasHook(proto, "onStop", FlareService.prototype);
      const hasDispose = hasHook(proto, "dispose", FlareService.prototype);

      if ((hasOnStart || hasOnStop) && hasDispose) {
        errors.push({
          severity: "error",
          code: "CONTRADICTORY_LIFECYCLE_HOOKS",
          message:
            `${reg.cls.name} defines both onStart()/onStop() and dispose(): these are contradictory lifetime signals.`,
          hint: `onStart/onStop imply singleton lifetime; dispose() implies scoped lifetime.`,
        });
      } else if (hasDispose) {
        errors.push({
          severity: "error",
          code: "INVALID_LIFECYCLE_HOOK",
          message:
            `${reg.cls.name} defines dispose() but is registered via host.singleton(). dispose() implies per-request lifetime.`,
          hint: `Use host.scoped() or remove dispose() and use onStop() for singleton cleanup.`,
        });
      }
    }

    for (const reg of ctx.controllers) {
      const proto = (reg.cls as Function).prototype;
      for (const hook of LIFECYCLE_HOOKS) {
        if (hasHook(proto, hook, ControllerBase.prototype)) {
          errors.push({
            severity: "error",
            code: "CONTROLLER_LIFECYCLE_HOOK",
            message: `Controller ${reg.cls.name} defines ${hook}(): lifecycle hooks are not valid on controllers.`,
            hint:
              `Controllers are always per-request. Use a scoped service with dispose() for cleanup, or a singleton service with onStart()/onStop() for app-lifetime hooks.`,
          });
        }
      }
    }

    for (const reg of ctx.middleware) {
      const proto = (reg.cls as Function).prototype;
      for (const hook of LIFECYCLE_HOOKS) {
        if (hasHook(proto, hook, MiddlewareBase.prototype)) {
          errors.push({
            severity: "error",
            code: "MIDDLEWARE_LIFECYCLE_HOOK",
            message: `Middleware ${reg.cls.name} defines ${hook}(): lifecycle hooks are not valid on middleware.`,
            hint: `Middleware is always per-request. Use a scoped service with dispose() for per-request cleanup.`,
          });
        }
      }
    }

    return errors;
  }
}

function hasHook(proto: object | null, hook: LifecycleHook, stopAt: object): boolean {
  let current = proto;
  while (current && current !== stopAt) {
    if (Object.prototype.hasOwnProperty.call(current, hook)) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}
