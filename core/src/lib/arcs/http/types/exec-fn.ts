import type { Container } from "../../../services/container.js";
import type { MiddlewareBase } from "../composition/classes/middleware-base.js";
import type { FlareHttpContext } from "../transport/flare-http-context.js";
import type { HandlerResult } from "../transport/types/response.js";

export type ExecFn = (
  ctx: FlareHttpContext,
  container: Container,
  middlewareCache: MiddlewareBase[],
  methodIdx: number,
) => HandlerResult | Promise<HandlerResult>;
