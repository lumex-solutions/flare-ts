/**
 * The compiled pipeline vocabulary: the per-route structure build produces and exec consumes.
 */
import type { Primitive } from "@flare-ts/lib/schema";
import type { Container } from "../../../services/container.js";
import type { CompiledCorsPolicy } from "../composition/types/cors.js";
import type { ControllerHandler, Route } from "../routing/types/route.js";
import type { FlareHttpContext } from "../transport/flare-http-context.js";
import type { ResponseSerializers } from "../transport/types/response.js";
import type { ControllerRegistration, ErrorHandlerRegistration } from "./registration.js";

export type CompiledQueryPrimitive = { readonly key: string; readonly primitive: Primitive; };

export type HttpFactory<T> = (container: Container, ctx: FlareHttpContext) => T;

export type Pipeline = {
  readonly registration: ControllerRegistration;
  readonly flareRoute: Omit<Route, "handlers">;
  readonly handlers: Array<ControllerHandler | null>;
  readonly execCount: number;
  readonly handlerExecIdx: number;
  readonly middlewareFactoryByExecIdx: Int32Array;
  readonly finallyCount: number;
  readonly responseSerializers: ResponseSerializers | undefined;
  readonly compiledQueryPrimitives: Array<CompiledQueryPrimitive[] | undefined>;
  readonly errorHandlers: readonly ErrorHandlerRegistration[];
  /** Per-method body size limits in bytes, indexed by methodIdx. undefined = use global default. */
  readonly maxBodyBytes: Array<number | undefined>;
  /** Precomputed CORS policy for this route, or undefined if no policy is attached. */
  readonly corsPolicy: CompiledCorsPolicy | undefined;
};
