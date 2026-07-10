/**
 * The class-form error-handler authoring base.
 */
import type { FlareError } from "../../../../errors/flare-error.js";
import type { HttpErrorContext } from "../../../../logger/types.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { Container } from "../../../../services/container.js";
import type { ServiceToken } from "../../../../services/types/token.js";
import type { ResponseLike } from "../../transport/types/response.js";
import { FlareBase } from "../../../../services/composition/flare-base.js";

/** Constructor type for a class registered with {@link HttpArc.error}. */
export type ErrorHandlerClass = {
  new(container: Container): ErrorHandlerBase;
  deps?: ServiceToken<FlareService>[];
};

/**
 * Base class for HTTP error handlers registered on {@link HttpArc.error}.
 *
 * Return a {@link ResponseLike} from {@link ErrorHandlerBase.handle} to send a custom response;
 * return `void` (or omit a return) to let the error propagate to the next handler or default path.
 */
export abstract class ErrorHandlerBase extends FlareBase {
  public static override deps: ServiceToken<FlareService>[];
  /**
   * Handles an error raised during the HTTP pipeline for the current request.
   *
   * @returns A response to short-circuit error handling, or `void` to defer to other handlers.
   */
  public abstract handle(
    err: FlareError | Error,
    context: HttpErrorContext,
  ): ResponseLike | void | Promise<ResponseLike | void>;
}
