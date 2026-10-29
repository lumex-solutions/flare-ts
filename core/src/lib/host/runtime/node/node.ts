/** The Node.js runtime adapter, exposed as `node` on `@flare-ts/core/node`. */
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { LoggerTransportClass } from "../../../logger/types.js";
import type { TestRequestInput } from "../../../testing/types/flare-test-req.js";
import type { SingletonExtension } from "../../extensions/singleton.js";
import type { HostRuntimeAdapter } from "../../types/adapter.js";
import { FlareRequest } from "../../../arcs/http/transport/flare-request.js";
import { nodeRequestAdapter } from "../../../arcs/http/transport/runtime/node.js";
import { WebSocketChannels } from "../../../arcs/ws/channels/web-socket-channels.js";
import { WS_CHANNEL_REGISTRY } from "../../../arcs/ws/ws-arc.js";
import { Logger } from "../../../logger/logger.js";
import { ConsoleTransport } from "../../../logger/transports/console.js";
import { singletonExtension } from "../../extensions/singleton.js";
import { PROVIDE_SERVICE } from "../../types/const.js";
import { FlareAppNode } from "./flare-app-node.js";

/**
 * Node.js runtime adapter. Reads `flare.json` synchronously from {@link process.cwd}, exposes
 * `process.env`, and installs {@link ConsoleTransport} as the default logger transport.
 */
export const node: HostRuntimeAdapter<FlareAppNode, LoggerTransportClass, "async", SingletonExtension> = {
  runtime: "node",
  lifecycle: "async",
  get flareJsonFile() {
    const filePath = `${process.cwd()}/flare.json`;
    return JSON.parse(readFileSync(filePath, "utf8"));
  },
  env: process.env,
  defaultLoggerTransports: [ConsoleTransport],
  createApp(host) {
    return new FlareAppNode(host);
  },
  createLogger(transports, container) {
    return new Logger(transports, container);
  },
  createTestRequest(input) {
    return buildNodeTestRequest(input);
  },
  extendHost(host) {
    return singletonExtension(host);
  },
  setup(host) {
    // The Node process is one broadcast domain: bind the injectable publish capability (WebSocketChannels)
    // to the same registry every Node WS connection joins (the arc's default domain), so an HTTP
    // handler or timer publishes into exactly the domain the connections live in.
    host[PROVIDE_SERVICE]("singleton", {
      token: WebSocketChannels,
      cls: WebSocketChannels,
      factory: (container) => new WebSocketChannels(container, host.ws[WS_CHANNEL_REGISTRY]()),
    });
  },
};

function buildNodeTestRequest(input: TestRequestInput): FlareRequest {
  // Synthesize an IncomingMessage-shaped object. `nodeRequestAdapter`'s `rawHeaders`
  // reads `req.headers` and `signal` attaches listeners via `req.once(event, fn)`.
  // FlareRequest body buffering uses the object as an AsyncIterable<Uint8Array>,
  // so a node Readable stream satisfies that contract.
  const headerRecord: Record<string, string | string[] | undefined> = {};
  if (input.headers) {
    if (input.headers instanceof Headers) {
      input.headers.forEach((value, key) => {
        headerRecord[key] = value;
      });
    } else {
      Object.assign(headerRecord, input.headers);
    }
  }

  const body = input.body == null
    ? Readable.from([] as Uint8Array[])
    : typeof input.body === "string"
    ? Readable.from([new TextEncoder().encode(input.body)])
    : input.body instanceof Uint8Array
    ? Readable.from([input.body])
    : Readable.from([new Uint8Array(input.body)]);

  const native = body as Readable & {
    headers: Record<string, string | string[] | undefined>;
    method: string;
    url: string;
    complete: boolean;
  };
  native.headers = headerRecord;
  native.method = input.method;
  native.url = input.url;
  native.complete = true;

  // Bridge an external AbortSignal into the Node-shaped lifecycle events that
  // `nodeRequestAdapter.signal()` listens for. When the test signal aborts,
  // emit `"aborted"` on the synthesized request so the abort-controller chain
  // inside the framework fires identically to a real socket-level abort.
  if (input.signal) {
    const fire = () => {
      native.complete = false;
      native.emit("aborted");
      native.emit("close");
    };
    if (input.signal.aborted) {
      queueMicrotask(fire);
    } else {
      input.signal.addEventListener("abort", fire, { once: true });
    }
  }

  return new FlareRequest(
    nodeRequestAdapter,
    input.method,
    input.url,
    input.requestId ?? `test-${crypto.randomUUID().slice(0, 8)}`,
    // A test-built fake standing in for the runtime-native request; it carries only the slices the
    // node adapter reads (headers, async-iterable body).
    native as unknown as IncomingMessage,
  );
}
