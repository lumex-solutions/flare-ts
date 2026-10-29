/**
 * The class-form middleware authoring base: before/after/finally hooks over the shared core.
 */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import type { ConfigToken } from "../../../../config/flare-config.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { Container } from "../../../../services/container.js";
import type { ServiceToken } from "../../../../services/types/token.js";
import type { StateToken } from "../../../../state/flare-state.js";
import type { FlareHttpContext } from "../../transport/flare-http-context.js";
import type { HandlerResult, MiddlewareOverride } from "../../transport/types/response.js";
import { FlareBase } from "../../../../services/composition/flare-base.js";
import { FlareResponse } from "../../transport/flare-response.js";

export type MiddlewareClass = {
  new(container: Container, ctx: FlareHttpContext): MiddlewareBase;
  /** @internal Marks a synthetic middleware wrapper whose user callback is async; read by exec codegen. */
  _asyncHook?: boolean;
  deps: ServiceToken<FlareService>[];
  state: StateToken[];
  provides?: StateToken[];
  config?: readonly ConfigToken<unknown>[] | undefined;
};

/**
 * Base class for HTTP middleware registered on {@link HttpArc.before}, {@link HttpArc.after},
 * or {@link HttpArc.finally}.
 *
 * Optional hooks run at different pipeline stages. {@link MiddlewareBase.provides} declares
 * state tokens written for downstream handlers in the same request.
 */
export abstract class MiddlewareBase extends FlareBase {
  /** @internal Marks a synthetic middleware wrapper whose user callback is async; read by exec codegen. */
  static _asyncHook?: boolean;

  public static override deps: ServiceToken<FlareService>[];
  public static state: StateToken[];
  /** State tokens this middleware writes for later handlers on the same request. */
  public static provides?: StateToken[];

  constructor(
    protected override readonly container: Container,
    protected ctx: FlareHttpContext,
  ) {
    super(container);
  }

  /**
   * Pre-handler hook. Return a {@link MiddlewareOverride} to short-circuit the route handler.
   */
  public before?(): MiddlewareOverride | Promise<MiddlewareOverride>;
  /**
   * Post-handler hook. Receives the handler result; may return a replacement response.
   */
  public after?(result: HandlerResult): MiddlewareOverride | Promise<MiddlewareOverride>;
  /**
   * Always-runs hook: called after every request regardless of whether it was short-circuited
   * by a `before()` hook, completed normally, or threw an error that was caught by an error handler.
   * Runs in LIFO order (last middleware first). May return a replacement handler result.
   */
  public finally?(result: HandlerResult): MiddlewareOverride | Promise<MiddlewareOverride>;

  protected badRequest<B extends ReadonlyJsonValue>(body: B): FlareResponse<400, B> {
    return new FlareResponse(400, body);
  }
  protected unauthorized<B extends ReadonlyJsonValue>(body: B): FlareResponse<401, B> {
    return new FlareResponse(401, body);
  }
  protected forbidden<B extends ReadonlyJsonValue>(body: B): FlareResponse<403, B> {
    return new FlareResponse(403, body);
  }
  protected notFound<B extends ReadonlyJsonValue>(body: B): FlareResponse<404, B> {
    return new FlareResponse(404, body);
  }
  protected tooManyRequests<B extends ReadonlyJsonValue>(body: B): FlareResponse<429, B> {
    return new FlareResponse(429, body);
  }
  protected error<B extends ReadonlyJsonValue>(body: B): FlareResponse<500, B> {
    return new FlareResponse(500, body);
  }
}
