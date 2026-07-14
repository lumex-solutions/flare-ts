/**
 * The root injectable base class: declared-deps DI via inject() and declared-config
 * access via config().
 */
import type { ConfigToken } from "../../config/flare-config.js";
import type { Container } from "../container.js";
import type { Injected } from "../types/inject.js";
import type { ServiceToken } from "../types/token.js";
import type { FlareService } from "./flare-service.js";

/**
 * Root injectable base class extended by all controllers, middleware, error handlers,
 * and services.
 *
 * Provides DI via `inject()` and config access via `config()`.
 * Lifecycle hooks (`onStart`, `onStop`, `dispose`) are NOT available here.
 * Services that require lifecycle management should extend {@link FlareService} instead.
 */
export abstract class FlareBase {
  /**
   * Declares the service tokens this class is allowed to `inject()`.
   *
   * Tokens not listed here cause `inject()` to throw at the call site, naming both
   * the class and the offending token.
   */
  public static deps: readonly ServiceToken<FlareService>[] | undefined;
  /**
   * Declares the config tokens this class requires.
   *
   * Parallel to `static deps`. When declared, `this.config(token)` validates that
   * the token is in this array before resolving, identical to how `this.inject(token)`
   * validates `static deps`.
   */
  public static config?: readonly ConfigToken<unknown>[] | undefined;

  constructor(
    /** @internal The DI container; subclasses resolve through `this.inject` / `this.config`, never directly. */
    protected readonly container: Container,
  ) {}

  /**
   * Resolves a dependency declared on `static deps`, returning the service with framework
   * members hidden from its static type.
   *
   * @throws {Error} When the token is not present in this class's `static deps` array.
   */
  public inject<T extends FlareService>(token: ServiceToken<T>): Injected<T> {
    // `constructor` is typed as plain Function; the subclass's statics live on the
    // concrete class, which the cast restates.
    const deps = (this.constructor as typeof FlareBase).deps;
    if (!deps || !deps.includes(token)) {
      throw new Error(
        `[flare] ${this.constructor.name} called inject("${token.name}") but "${token.name}" is not declared in ${this.constructor.name}.deps. Add it to the static deps array.`,
      );
    }
    // Injected<T> is a compile-time projection of T; the container returns the full
    // instance and the type system cannot relate the two.
    return this.container.resolveDep(token) as Injected<T>;
  }

  /**
   * Resolves a typed config section by token.
   *
   * Mirrors `inject()` + `static deps`: the class must declare a `static config`
   * array, and the requested token must appear in it. Both checks throw a
   * developer-facing error when violated.
   *
   * @example
   * ```ts
   * class DbService extends FlareService {
   *   static config = [DbConfig];
   *
   *   async onStart() {
   *     const { url } = this.config(DbConfig);
   *   }
   * }
   * ```
   *
   * @throws {Error} When the class has no `static config` declaration.
   * @throws {Error} When the token is not present in `static config`.
   */
  protected config<T>(token: ConfigToken<T>): T {
    // Same statics-on-the-concrete-class narrowing as inject() above.
    const declared = (this.constructor as typeof FlareBase).config;
    if (declared === undefined) {
      throw new Error(
        `[flare] ${this.constructor.name} called config("${token.key}") but ${this.constructor.name} does not declare a static config array. Add "static config = [/* tokens */]" to the class.`,
      );
    }
    // The declared array's element type is ConfigToken<unknown>; includes() cannot
    // accept the narrower ConfigToken<T> without widening the token first.
    if (!declared.includes(token as ConfigToken<unknown>)) {
      throw new Error(
        `[flare] ${this.constructor.name} called config() with token "${token.key}" but "${token.key}" is not declared in ${this.constructor.name}.config. Add it to the static config array.`,
      );
    }
    return this.container.resolveCfg(token);
  }
}
