import { FlareHost } from "../flare-host.js";

/**
 * Runtime backing for a declaration-merged host method (e.g. `host.durable()`).
 *
 * Extension packages augment the `FlareHost` interface with a typed method via `declare module`
 * (the compile-time half), then call this at module load to install the implementation (the runtime
 * half). Importing the extension module — which using its adapter forces — runs this call.
 *
 * The patch is a module side effect: keep the extension's emitted module in `package.json`
 * `sideEffects` so bundlers do not tree-shake the registration away.
 *
 * @throws If a host extension with the same name is already defined (collision guard).
 *
 * @example
 * ```ts
 * // compile-time: declare module "@flare-ts/core" { interface FlareHost<T> { useThing(opts: ThingOpts): void } }
 * defineHostExtension("useThing", function (this: FlareHost<never>, opts: ThingOpts) {
 *   this.scoped(makeThingService(opts));
 * });
 * ```
 */
export function defineHostExtension(
  name: string,
  // The implementation runs with `this` bound to the host; both are intentionally loose here since
  // the public, typed surface comes from the package's `declare module` augmentation.
  fn: (this: FlareHost<never>, ...args: never[]) => void,
): void {
  if (name in FlareHost.prototype) {
    throw new Error(
      `[flare] host extension "${name}" is already defined. Two extensions cannot claim the same host method name.`,
    );
  }
  (FlareHost.prototype as unknown as Record<string, unknown>)[name] = fn;
}
