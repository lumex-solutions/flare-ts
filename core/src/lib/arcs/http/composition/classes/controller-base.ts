/**
 * The class-form route authoring base: response helpers over the shared registration core.
 */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import type { ConfigToken } from "../../../../config/flare-config.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { Container } from "../../../../services/container.js";
import type { ServiceToken } from "../../../../services/types/token.js";
import type { StateToken } from "../../../../state/flare-state.js";
import type { FlareHttpContext } from "../../transport/flare-http-context.js";
import type { ResponseLike } from "../../transport/types/response.js";
import type { ContractToken } from "../contract/http-contract.js";
import { FlareBase } from "../../../../services/composition/flare-base.js";
import { FlareResponse } from "../../transport/flare-response.js";

export type RedirectOptions = {
  permanent?: boolean;
  preserveMethod?: boolean;
};

export type ControllerClass = {
  new(container: Container, ctx: FlareHttpContext): ControllerBase;
  deps: ServiceToken<FlareService>[];
  state: StateToken[];
  contract?: ContractToken | undefined;
  config?: readonly ConfigToken<unknown>[] | undefined;
  isolated?: boolean | undefined;
};

/**
 * Base class for class-based HTTP controllers registered on {@link HttpArc}.
 *
 * Subclasses use the protected response helpers to return {@link ResponseLike} values from route handlers.
 */
export abstract class ControllerBase extends FlareBase {
  public static override deps: ServiceToken<FlareService>[];
  public static state: StateToken[];
  public static contract?: ContractToken | undefined;
  /** Runs this controller's routes with NO global middleware (the class-form spelling of the `isolated` route option). */
  public static isolated?: boolean | undefined;

  constructor(
    protected override readonly container: Container,
    protected ctx: FlareHttpContext,
  ) {
    super(container);
  }

  /** Returns HTTP 200 with a JSON or text body. */
  protected ok<B extends ReadonlyJsonValue>(body: B): FlareResponse<200, B> {
    return new FlareResponse(200, body);
  }
  /** Returns HTTP 201 with a JSON or text body. */
  protected created<B extends ReadonlyJsonValue>(body: B): FlareResponse<201, B> {
    return new FlareResponse(201, body);
  }
  /** Returns HTTP 204 with no body. */
  protected noContent(): FlareResponse<204> {
    return new FlareResponse(204);
  }
  /**
   * Returns an HTTP redirect (302 by default; 301/307/308 when `permanent` / `preserveMethod` are set).
   */
  protected redirect(location: string, options?: RedirectOptions): FlareResponse<301 | 302 | 307 | 308, null> {
    const permanent = options?.permanent === true;
    const preserveMethod = options?.preserveMethod === true;
    const status = permanent ? (preserveMethod ? 308 : 301) : preserveMethod ? 307 : 302;
    return new FlareResponse(status, null, { headers: { Location: location } });
  }
  /** Returns HTTP 400 with a JSON or text body. */
  protected badRequest<B extends ReadonlyJsonValue>(body: B): FlareResponse<400, B> {
    return new FlareResponse(400, body);
  }
  /** Returns HTTP 401 with a JSON or text body. */
  protected unauthorized<B extends ReadonlyJsonValue>(body: B): FlareResponse<401, B> {
    return new FlareResponse(401, body);
  }
  /** Returns HTTP 403 with a JSON or text body. */
  protected forbidden<B extends ReadonlyJsonValue>(body: B): FlareResponse<403, B> {
    return new FlareResponse(403, body);
  }
  /** Returns HTTP 404 with a JSON or text body. */
  protected notFound<B extends ReadonlyJsonValue>(body: B): FlareResponse<404, B> {
    return new FlareResponse(404, body);
  }
  /** Returns HTTP 429 with a JSON or text body. */
  protected tooManyRequests<B extends ReadonlyJsonValue>(body: B): FlareResponse<429, B> {
    return new FlareResponse(429, body);
  }
  /** Returns HTTP 500 with a JSON or text body. */
  protected error<B extends ReadonlyJsonValue>(body: B): FlareResponse<500, B> {
    return new FlareResponse(500, body);
  }
}
