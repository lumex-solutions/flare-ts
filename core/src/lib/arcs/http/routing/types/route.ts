import type { ControllerBase, ControllerClass } from "../../composition/classes/controller-base.js";
import type { RequestDescriptor } from "../../composition/contract/flare-contract.js";
import type { HandlerResult } from "../../transport/types/response.js";

export type ControllerHandler = (this: ControllerBase, ...args: string[]) => HandlerResult | Promise<HandlerResult>;

export type RouteMetadata = {
  method: string;
  path: string;
  handler: ControllerHandler;
};

export type RouteSegment = {
  startIdxs: Int16Array;
  endIdxs: Int16Array;
};

export type Route = {
  route: string;
  handlers: ControllerHandler[];
  requestDescriptors: Array<RequestDescriptor | undefined>;
  score: number;
  controllerRef: ControllerClass;

  segments: RouteSegment;
  paramCount: number;
};
