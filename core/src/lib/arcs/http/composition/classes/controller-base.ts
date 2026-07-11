import type { JsonValue } from "@flare-ts/lib/schema";
/**
 * The class-form route authoring base: response helpers over the shared registration core.
 */
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

  #createResponse(body: JsonValue | null, status: number): ResponseLike {
    if (body === null) {
      return new FlareResponse(status);
    }

    if (typeof body === "string") {
      return new FlareResponse(status, body);
    }

    return new FlareResponse(status, body);
  }

  /** Returns HTTP 200 with a JSON or text body. */
  protected ok(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 200);
  }
  /** Returns HTTP 201 with a JSON or text body. */
  protected created(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 201);
  }
  /** Returns HTTP 204 with no body. */
  protected noContent(): ResponseLike {
    return this.#createResponse(null, 204);
  }
  /**
   * Returns an HTTP redirect (302 by default; 301/307/308 when `permanent` / `preserveMethod` are set).
   */
  protected redirect(location: string, options?: RedirectOptions): ResponseLike {
    const permanent = options?.permanent === true;
    const preserveMethod = options?.preserveMethod === true;
    const status = permanent ? (preserveMethod ? 308 : 301) : preserveMethod ? 307 : 302;
    return new FlareResponse(status, null, { headers: { Location: location } });
  }
  /** Returns HTTP 400 with a JSON or text body. */
  protected badRequest(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 400);
  }
  /** Returns HTTP 401 with a JSON or text body. */
  protected unauthorized(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 401);
  }
  /** Returns HTTP 403 with a JSON or text body. */
  protected forbidden(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 403);
  }
  /** Returns HTTP 404 with a JSON or text body. */
  protected notFound(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 404);
  }
  /** Returns HTTP 429 with a JSON or text body. */
  protected tooManyRequests(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 429);
  }
  /** Returns HTTP 500 with a JSON or text body. */
  protected error(body: JsonValue): ResponseLike {
    return this.#createResponse(body, 500);
  }
}
