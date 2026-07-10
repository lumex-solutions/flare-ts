/**
 * The front-door Worker request handler.
 */
import { CfHandlerBase } from "./cf-handler-base.js";

/** Front-door (Worker isolate) handler: routes requests with no Durable Object state crossing. */
export class WorkerHandler extends CfHandlerBase {}
