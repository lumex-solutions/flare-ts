/**
 * The lifecycle-capable injectable base class: onStart/onStop for singletons and
 * dispose for scoped services.
 */
import { FlareBase } from "./flare-base.js";

/**
 * Injectable base class for services that participate in the application lifecycle.
 *
 * Extend this (instead of {@link FlareBase}) when your service needs `onStart`,
 * `onStop`, or `dispose` hooks. Must be registered via `host.scoped()` or
 * `host.singleton()`.
 */
export abstract class FlareService extends FlareBase {
  /**
   * Called once when a singleton service starts (FlareApp.start()).
   *
   * Not called for scoped services.
   */
  onStart?(): Promise<void> | void;

  /**
   * Called once when a singleton service stops (FlareApp.stop()).
   *
   * Not called for scoped services.
   */
  onStop?(): Promise<void> | void;

  /**
   * Called at the end of every request for scoped services, whether the handler succeeded or threw.
   *
   * This is a correctness boundary: the framework waits for any returned promise before completing
   * the request pipeline. Use it for per-request cleanup that must finish, such as rolling back
   * transactions, releasing locks, or closing cursors.
   *
   * If a service wants fire-and-forget background work, schedule that work inside dispose() and
   * return void. Implies scoped lifetime: declaring this on a singleton class throws at build() time.
   */
  dispose?(): Promise<void> | void;
}
