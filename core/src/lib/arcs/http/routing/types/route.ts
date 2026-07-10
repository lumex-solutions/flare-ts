/**
 * The compiled route vocabulary: handler shape, metadata, and segments.
 */
import type { ControllerBase, ControllerClass } from "../../composition/classes/controller-base.js";
import type { RequestDescriptor } from "../../composition/contract/http-contract.js";
import type { HandlerResult } from "../../transport/types/response.js";

/** A decorated route method as the compiled pipeline invokes it: bound to its controller, params as strings. */
export type ControllerHandler = (this: ControllerBase, ...args: string[]) => HandlerResult | Promise<HandlerResult>;

/** One decorated route as recorded by the @Method decorators: verb, path, and the handler. */
export type RouteMetadata = {
  method: string;
  path: string;
  handler: ControllerHandler;
};

/** Pre-split segment offsets for one route pattern, reused at match time. */
export type RouteSegment = {
  startIdxs: Int16Array;
  endIdxs: Int16Array;
};

/** One compiled route: its pattern, per-method handlers and descriptors, sort score, and owner class. */
export type Route = {
  route: string;
  handlers: ControllerHandler[];
  requestDescriptors: Array<RequestDescriptor | undefined>;
  score: number;
  controllerRef: ControllerClass;

  segments: RouteSegment;
  paramCount: number;
};
