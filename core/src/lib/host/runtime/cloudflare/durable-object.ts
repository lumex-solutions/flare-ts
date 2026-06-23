import { DurableObject } from "cloudflare:workers";
import type { StateToken } from "../../../arcs/http/state/types/state-token.js";
import type { ConfigToken } from "../../../config/flare-config.js";
import type { Injected } from "../../../services/composition/flare-base.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { IFlareHost } from "../../flare-host.js";
import { COMPILE_INSTANCE_CONTAINER } from "../../types/const.js";
import { arcForDurableObject } from "./app.js";
import { FlareCfHandler } from "./handler.js";
import { Bindings, DurableState } from "./services.js";

/** Map of per-context seed factories handed to `[COMPILE_INSTANCE_CONTAINER]`. */
type SeedMap = Map<ServiceToken<FlareService>, (container: Container) => FlareService>;

/**
 * Structural shape of a Durable Object class for host registration. The concrete cloudflare
 * FlareDurableObject base satisfies this; typing it structurally keeps the shared host free of any
 * compile-time dependency on the cloudflare:workers module graph (Node/Bun/Deno builds never load it).
 *
 * @internal Users extend `FlareDurableObject`, not this.
 */
export interface FlareDurableObjectClass {
  new(...args: any[]): object;
  readonly deps?: readonly ServiceToken<FlareService>[];
  readonly name: string;
}

/**
 * Stamped onto a `FlareDurableObject` subclass by `host.durableObject(Class)` so each instance can
 * retrieve its host and compose its per-instance container without prop-drilling.
 */
export const DO_HOST: unique symbol = Symbol("flare.do.host");

/**
 * Composes one DO instance's per-instance lazy container (seeds DurableState + Bindings).
 *
 * @internal Exported so white-box tests can drive the real per-instance composition with a synthetic
 * `DurableObjectState` (workerd's native `DurableObject` base rejects a fake ctx, so the DO class
 * itself can only be constructed by the runtime).
 */
export function composeDurableInstance(
  host: IFlareHost,
  state: DurableObjectState,
  env: Cloudflare.Env,
  cls: FlareDurableObjectClass,
): FlareCfHandler {
  const seed: SeedMap = new Map();
  seed.set(DurableState, (c) => new DurableState(c, state));
  seed.set(Bindings, (c) => new Bindings(c, env));
  const container = host[COMPILE_INSTANCE_CONTAINER](seed);
  const arcEntry = arcForDurableObject(cls);
  if (arcEntry === undefined) {
    throw new Error(
      `[flare] ${cls.name} has no per-DO arc. Call host.durableObject(${cls.name}) before host.build().`,
    );
  }
  // arcEntry is null when the DO was registered with zero routes: FlareCfHandler returns 404.
  return new FlareCfHandler(host, container, arcEntry, { cls });
}

/**
 * Base class for Flare Durable Objects. Extend it, declare `static deps`, register with
 * `host.durableObject(Class)` before `host.build()`.
 *
 * Each instance composes its own per-instance lazy container seeded with `DurableState` and
 * `Bindings`. User scoped services registered via `host.scoped()` resolve lazily per instance.
 */
export class FlareDurableObject extends DurableObject<Cloudflare.Env> {
  static deps: readonly ServiceToken<FlareService>[] = [];
  static state: readonly StateToken[] = [];

  #handler: FlareCfHandler;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const host = (this.constructor as { [DO_HOST]?: IFlareHost; })[DO_HOST];
    if (!host) {
      throw new Error(
        `[flare] ${this.constructor.name} was constructed without registration. `
          + `Call host.durableObject(${this.constructor.name}) before host.build().`,
      );
    }
    this.#handler = composeDurableInstance(host, ctx, env, this.constructor as FlareDurableObjectClass);
  }

  /** Resolves a service declared in this class's `static deps` from the per-instance graph. */
  protected inject<T extends FlareService>(token: ServiceToken<T>): Injected<T> {
    return this.#handler.inject((this.constructor as typeof FlareDurableObject).deps, token);
  }

  /** Resolves a config token. */
  protected config<T>(token: ConfigToken<T>): T {
    return this.#handler.config(token);
  }

  /** Serves this DO's HTTP requests through the app's http arc. Override to customize; call super.fetch to delegate. */
  fetch(request: Request): Promise<Response> {
    return this.#handler.fetch(request);
  }
}
