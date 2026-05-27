import type { ControllerClass } from "../composition/classes/controller-base.js";
import type { ControllerBase } from "../composition/classes/index.js";
import type { METHOD_IDX_MAP } from "./types/methods.js";
import type { ControllerHandler, RouteMetadata } from "./types/route.js";
import { ROUTE_STORE } from "./route-store.js";
import { SUPPORTED_METHODS } from "./types/methods.js";

/**
 * Registers the decorated method as a handler for `GET path`.
 *
 * Place this decorator on a method of a {@link ControllerBase} subclass.
 * A single controller can have multiple methods decorated with different
 * HTTP-method decorators.
 *
 * @param path - The URL path pattern to match (e.g. `"/users/:id"`).
 *
 * @example
 * ```ts
 * class UsersController extends ControllerBase {
 *   static deps = [];
 *   static state = [];
 *
 *   @Get("/users/:id")
 *   async getUser() {
 *     return this.ok({ id: this.ctx.params.id });
 *   }
 * }
 * ```
 */
export function Get(path: string): Function {
  return Method("GET", path);
}

/**
 * Registers the decorated method as a handler for `POST path`.
 *
 * @param path - The URL path pattern to match.
 */
export function Post(path: string): Function {
  return Method("POST", path);
}

/**
 * Registers the decorated method as a handler for `PUT path`.
 *
 * @param path - The URL path pattern to match.
 */
export function Put(path: string): Function {
  return Method("PUT", path);
}

/**
 * Registers the decorated method as a handler for `PATCH path`.
 *
 * @param path - The URL path pattern to match.
 */
export function Patch(path: string): Function {
  return Method("PATCH", path);
}

/**
 * Registers the decorated method as a handler for `DELETE path`.
 *
 * @param path - The URL path pattern to match.
 */
export function Delete(path: string): Function {
  return Method("DELETE", path);
}

/**
 * Registers the decorated method as a handler for `HEAD path`.
 *
 * @param path - The URL path pattern to match.
 */
export function Head(path: string): Function {
  return Method("HEAD", path);
}

/**
 * Registers the decorated method as a handler for `OPTIONS path`.
 *
 * @param path - The URL path pattern to match.
 */
export function Options(path: string): Function {
  return Method("OPTIONS", path);
}

/**
 * Registers the decorated method as a handler for an arbitrary HTTP method.
 *
 * Use this when none of the named decorators (`@Get`, `@Post`, etc.) fit.
 * Only methods in the framework's supported set are accepted (same list as the named decorators).
 *
 * @param method - The HTTP method string (e.g. `"OPTIONS"`, `"HEAD"`).
 * @param path - The URL path pattern to match.
 */
export function Method(method: string, path?: string): Function {
  return function(target: ControllerHandler, context: ClassMethodDecoratorContext) {
    if (!SUPPORTED_METHODS.includes(method as keyof typeof METHOD_IDX_MAP)) {
      throw new Error(
        `Unsupported HTTP method "${method}" on route "${target.constructor.name}.${path}". Supported methods are: ${
          SUPPORTED_METHODS.join(", ")
        }`,
      );
    }

    // Forbid "/" as the path argument; controller root routes are expressed by omitting the argument.
    // Avoids edge cases in path normalization.
    if (path === "/") {
      throw new Error('Path cannot be "/". Omit the argument for controller root routes.');
    }

    // Omitted path normalizes to the controller root route.
    if (path === undefined) {
      path = "";
    }

    // Non-root paths must start with "/" and must not end with "/".
    if (path !== "") {
      if (!path.startsWith("/")) {
        throw new Error(`Path must start with "/": ${path}`);
      }

      if (path.endsWith("/")) {
        throw new Error(`Path must not end with "/": ${path}`);
      }
    }

    const metadata = context.metadata as DecoratorMetadataObject;
    const route: RouteMetadata = { method, path, handler: target as ControllerHandler };
    const routes = ROUTE_STORE.get(metadata) ?? [];
    routes.push(route);
    ROUTE_STORE.set(metadata, routes);
  };
}

export function registerRoute(cls: ControllerClass, method: string, handlerName: string): void {
  const metaSym = Symbol.metadata ?? Symbol.for("Symbol.metadata");
  // TODO(review): replace any - ControllerClass type does not expose Symbol.metadata indexing yet.
  const metadata = (cls as any)[metaSym] as DecoratorMetadataObject;
  const handler = cls.prototype[handlerName] as ControllerHandler;
  const routes = ROUTE_STORE.get(metadata) ?? [];
  routes.push({ method, path: "", handler });
  ROUTE_STORE.set(metadata, routes);
}
