import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { Container } from "../../../../services/container.js";
import type { ServiceToken } from "../../../../services/types/types.js";
import type { StateToken } from "../../../../state/types/state-token.js";
import type { FlareHttpContext } from "../../transport/flare-http-context.js";
import type { HandlerResult, MiddlewareOverride, ResponseLike } from "../../transport/types/response.js";
import type { AfterMiddlewareHandler, BeforeMiddlewareHandler, FinallyMiddlewareHandler } from "../types/handlers.js";
import { FlareBase } from "../../../../services/composition/flare-base.js";
import { FlareResponse } from "../../transport/flare-response.js";

export type MiddlewareBeforeFn = BeforeMiddlewareHandler;
export type MiddlewareAfterFn = AfterMiddlewareHandler;
export type MiddlewareFinallyFn = FinallyMiddlewareHandler;
export type MiddlewareFn = MiddlewareBeforeFn | MiddlewareAfterFn | MiddlewareFinallyFn;

export type MiddlewareClass = {
  new(container: Container, ctx: FlareHttpContext): MiddlewareBase;
  deps: ServiceToken<FlareService>[];
  state: StateToken[];
  provides?: StateToken[];
};

/**
 * Base class for HTTP middleware registered on {@link HttpArc.before}, {@link HttpArc.after},
 * or {@link HttpArc.finally}.
 *
 * Optional hooks run at different pipeline stages. {@link MiddlewareBase.provides} declares
 * state tokens written for downstream handlers in the same request.
 */
export abstract class MiddlewareBase extends FlareBase {
  public static override deps: ServiceToken<FlareService>[];
  public static state: StateToken[];
  /** State tokens this middleware writes for later handlers on the same request. */
  public static provides?: StateToken[];

  constructor(
    protected override container: Container,
    protected ctx: FlareHttpContext,
  ) {
    super(container);
  }

  #createResponse(body: JsonValue, status: number): ResponseLike {
    return new FlareResponse(status, body);
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

  protected badRequest(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 400);
  }
  protected unauthorized(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 401);
  }
  protected forbidden(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 403);
  }
  protected notFound(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 404);
  }
  protected tooManyRequests(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 429);
  }
  protected error(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 500);
  }
}
