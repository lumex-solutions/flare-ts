import type {
  ControllerRegistration,
  ErrorHandlerRegistration,
  GroupRegistration,
  MiddlewareRegistration,
} from "../types/registration.js";
import type { MiddlewareClass } from "./classes/middleware-base.js";
import { assertRegistrationPath } from "../../../routing/path.js";
import { HttpBase } from "./base.js";

/**
 * Signature for the builder callback passed to `app.group(prefix, fn)`.
 *
 * Receives a {@link HttpGroup} and must return a {@link GroupRegistration}
 * by calling `.register()` after configuring routes, middleware, and error handlers.
 */
export type HttpGroupFn = (group: HttpGroup) => GroupRegistration;

/**
 * Scoped sub-application for grouping related routes under a shared path prefix.
 *
 * Extends {@link HttpBase}, so it supports the full registration API (`use`,
 * `controller`, `get`, `post`, `error`, etc.). Routes registered inside a
 * group are automatically prefixed.
 *
 * Call {@link isolated} to give the group its own middleware scope.
 * Group scoped services are not supported.
 *
 * @example
 * ```ts
 * app.group("/api/v1", (group) => {
 *   group.use(AuthMiddleware);
 *   group.get("/users", async (ctx) => { ... });
 *   return group.register();
 * });
 * ```
 */
export class HttpGroup extends HttpBase {
  constructor(readonly prefix: string) {
    super();
    assertRegistrationPath(prefix, "Group prefix");
  }

  protected override _asGroupParent(): this {
    return this;
  }

  #isolated = false;
  readonly #excludeList: MiddlewareClass[] = [];
  readonly #replaceMap: Map<MiddlewareClass, MiddlewareRegistration> = new Map();

  get isIsolated() {
    return this.#isolated;
  }

  /**
   * Marks this group as isolated.
   *
   * Isolated groups have their own middleware scope: middleware registered
   * inside the group does not execute for routes outside the group, and vice versa.
   * Useful for grouping routes that require a specific middleware configuration.
   */
  isolated(): this {
    this.#isolated = true;
    return this;
  }

  /**
   * Excludes specific global middleware classes from this group's middleware chain.
   * The group inherits all other global middleware. Throws at `build()` if any
   * excluded class is not present in the global middleware list.
   *
   * @param classes - The middleware classes to exclude.
   */
  exclude(classes: MiddlewareClass[]): this {
    this.#excludeList.push(...classes);
    return this;
  }

  /**
   * Replaces a global middleware class with a different class in this group's chain.
   * Equivalent to `exclude(from)` + prepending `to` to the group middleware.
   * The replacement runs at the group middleware level (after remaining global middleware).
   *
   * @param from - The global middleware class to replace.
   * @param to - The replacement middleware class.
   */
  replace(from: MiddlewareClass, to: MiddlewareClass): this {
    this.#excludeList.push(from);
    this.#replaceMap.set(from, { factory: (container, ctx) => new to(container, ctx), cls: to });
    return this;
  }

  // TODO: Remove register and instead wrap the group builder callback so that the group
  // is mutated by the builder callback and registered automatically rather than calling register explicitly
  /**
   * Finalises the group and returns the {@link GroupRegistration}
   * containing all accumulated routes, middleware, and error handlers.
   */
  register(): GroupRegistration {
    const controllers = [...this.conRegistrations];
    const middleware = [...this.mwRegistrations];
    const errorHandlers = [...this.errorHandlers];
    // Replacements prepend to group middleware (they run after global minus excluded).
    const replacements = [...this.#replaceMap.values()];

    for (const controller of controllers) {
      this.#bindControllerGroupScope(
        controller,
        middleware,
        this.#isolated,
        errorHandlers,
        this.#excludeList,
        replacements,
      );
    }

    return {
      prefix: this.prefix,
      controllers,
      middleware,
      errorHandlers,
      isolated: this.#isolated,
      corsConfig: this.corsConfig,
    };
  }

  #bindControllerGroupScope(
    registration: ControllerRegistration,
    middleware: readonly MiddlewareRegistration[],
    isolated: boolean,
    errorHandlers: readonly ErrorHandlerRegistration[] = [],
    excludeList: readonly MiddlewareClass[] = [],
    replacements: readonly MiddlewareRegistration[] = [],
  ): void {
    const combinedMw = isolated ? undefined : [...replacements, ...middleware];
    registration.group = {
      middleware,
      isolated,
      errorHandlers,
      excludeList,
      replacements,
      ...(combinedMw ? { combinedMw } : {}),
    };
  }
}
