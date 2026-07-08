import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { ResponseLike } from "../../arcs/http/transport/types/response.js";
import type { IFlareWebSocket } from "../../arcs/ws/transport/socket.js";
import type { HostConfig, LogConfig } from "../../config/flare-config.js";
import type { LogContext } from "../../logger/types.js";
import type { LoggerTransportClass } from "../../logger/types.js";
import type { FlareTestRequestInput } from "../../testing/types/flare-test-req.js";
import type { SingletonExtension } from "../extensions/singleton.js";
import type { HostRuntimeAdapter } from "../types/adapter.js";
import { DRAIN_SET_COOKIES, FlareHttpContext } from "../../arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../arcs/http/transport/flare-response.js";
import { nodeRequestAdapter } from "../../arcs/http/transport/runtime/node.js";
import { WebSocketChannels } from "../../arcs/ws/channels/web-socket-channels.js";
import { handleNodeWsUpgrade } from "../../arcs/ws/transport/runtime/node/upgrade.js";
import { WS_CHANNEL_REGISTRY, WS_REGISTRATIONS } from "../../arcs/ws/ws-arc.js";
import { loggerALS } from "../../logger/context.js";
import { Logger } from "../../logger/logger.js";
import { ConsoleTransport } from "../../logger/transports/console.js";
import { singletonExtension } from "../extensions/singleton.js";
import { FlareAppBase } from "../flare-app.js";
import { PROVIDE_SERVICE, SET_HOST_STATE } from "../types/const.js";

// TODO: Move into a /node folder, extract types, multiple files for main pieces, etc

/** @internal Internal options for {@link FlareAppNode.#shutdown}. */
type NodeShutdownOptions = {
  exitCode: 0 | 1;
  exitProcess: boolean;
};

/** Options accepted by {@link FlareAppNode.run}. Values fall back to `host` config, then framework defaults. */
export type NodeRunOptions = {
  port?: number;
  host?: string;
  shutdownTimeout?: number;
};

/** Handle returned by {@link FlareAppNode.run}. Holds the bare server reference and a graceful stop callback. */
export type NodeRunHandle = {
  readonly server: Server;
  stop(): Promise<void>;
};

function buildNodeTestRequest(input: FlareTestRequestInput): FlareRequest {
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

/**
 * Compiled Flare application for Node.js. Serves requests via the built-in `node:http` server with
 * graceful shutdown on signal or fatal error.
 */
export class FlareAppNode extends FlareAppBase {
  #server: Server | undefined;

  #activeRequests = 0;

  #isShuttingDown = false;
  #shutdownPromise: Promise<void> | undefined;
  #shutdownTimeout = 10_000;
  #emitRequestIdHeader = true;
  #captureRequestTiming = false;

  #waitForActiveRequestsResolve: (() => void) | undefined;
  #exitAfterShutdown = false;

  /** Live WebSocket connections, closed gracefully on shutdown so `server.close()` can drain. */
  readonly #wsConnections = new Set<IFlareWebSocket>();

  // Process-level handlers installed by #bindProcessHandlers, kept so #shutdown can remove them
  // (a run()/stop() cycle must not leak listeners or leave a stopped app wired to process events).
  #onSigterm: (() => void) | undefined;
  #onSigint: (() => void) | undefined;
  #onUncaught: ((err: Error, origin: string) => void) | undefined;
  #onUnhandled: ((reason: unknown) => void) | undefined;

  #requestSeq = 0;
  readonly #requestNonce = crypto.randomUUID().slice(0, 8);

  /**
   * Starts the HTTP server, binds process signal handlers, and returns a handle for stopping the
   * application without exiting the host process.
   *
   * @throws If invoked more than once on the same app instance.
   */
  run(options?: NodeRunOptions): NodeRunHandle {
    if (this.#server) {
      throw new Error("[flare] FlareAppNode.run() can only be called once per app instance.");
    }

    this.#bindProcessHandlers();

    const hostCfg = this.host.config.host as HostConfig;
    const logCfg = this.host.config.log as LogConfig;

    const port = options?.port ?? hostCfg.port ?? 3000;
    const host = options?.host ?? hostCfg.host ?? "localhost";

    this.#shutdownTimeout = options?.shutdownTimeout ?? hostCfg.shutdownTimeout ?? 10_000;
    this.#emitRequestIdHeader = hostCfg.requestIdHeader === true;
    this.#captureRequestTiming = hostCfg.requestTiming === true;

    const server = createServer((req, res) => {
      this.#handleIncomingRequest(req, res);
    });

    // Apply connection-level timeouts
    server.keepAliveTimeout = hostCfg.keepAliveTimeout ?? 65_000;
    server.headersTimeout = hostCfg.headersTimeout ?? 60_000;
    server.requestTimeout = hostCfg.requestTimeout ?? 300_000;

    this.#wireWebSocketUpgrade(server);
    this.#server = server;

    if (logCfg.enableContext) {
      const logContext: LogContext = {
        source: "flare:host",
      };

      loggerALS.run({ context: logContext }, () => {
        this.#start(server, port, host);
      });
    } else {
      this.#start(server, port, host);
    }

    return {
      server,
      stop: () => this.#shutdown({ exitCode: 0, exitProcess: false }),
    };
  }

  #start(server: Server, port: number, host: string): Promise<void> {
    return this.startAsync()
      .then(() => {
        if (this.#isShuttingDown) return;

        return new Promise<void>((resolve, reject) => {
          const listenStart = Date.now();
          const onError = (err: Error) => {
            server.off("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            server.off("error", onError);
            this.host[SET_HOST_STATE]("ready");
            this.host.logger.trace("Lifecycle event", {
              phase: "runtime",
              component: "runtime",
              event: "server:listen:ready",
              runtime: "node",
              host,
              port,
              durationMs: Date.now() - listenStart,
            });
            this.host.logger.info(`HTTP server started listening on http://${host}:${port}`);
            resolve();
          };

          server.once("error", onError);
          this.host.logger.trace("Lifecycle event", {
            phase: "runtime",
            component: "runtime",
            event: "server:listen:start",
            runtime: "node",
            host,
            port,
          });
          server.listen(port, host, onListening);
        });
      })
      .catch((err) => {
        this.host.logger.fatal(err, "Failed to start application");

        this.#shutdown({ exitCode: 1, exitProcess: true });
      });
  }

  /**
   * Attaches the WebSocket `upgrade` handler when any `host.ws` route is registered. With no routes,
   * the listener is omitted and Node's default (destroy the socket) handles stray upgrades. New
   * upgrades are refused once shutdown has begun.
   */
  #wireWebSocketUpgrade(server: Server): void {
    if (this.host.ws[WS_REGISTRATIONS]().length === 0) return;
    server.on("upgrade", (req, socket, head) => {
      if (this.#isShuttingDown) {
        socket.destroy();
        return;
      }
      const conn = handleNodeWsUpgrade(this.host, req, socket, head);
      if (conn) {
        // Track live connections so graceful shutdown can close them; deregister when the socket dies.
        this.#wsConnections.add(conn);
        socket.on("close", () => this.#wsConnections.delete(conn));
      }
    });
  }

  #handleIncomingRequest(req: IncomingMessage, res: ServerResponse): void {
    if (this.#isShuttingDown) {
      res.writeHead(503, { "content-type": "application/json", connection: "close" });
      res.end('{"error":"Service Unavailable"}');
      return;
    }

    const startTime = this.#captureRequestTiming ? Date.now() : undefined;
    const request = new FlareRequest(
      nodeRequestAdapter,
      req.method ?? "GET",
      req.url ?? "/",
      `${this.#requestNonce}-${++this.#requestSeq}`,
      req,
      startTime,
    );

    const ctx = new FlareHttpContext(request);

    this.#activeRequests++;

    if (this.host.config.log?.enableContext) {
      const logContext: LogContext = {
        source: "flare:http",
        requestId: request.requestId,
        method: request.method,
        url: request.url,
      };

      loggerALS.run({ context: logContext }, () => {
        this.#fetch(ctx, res);
      });
    } else {
      this.#fetch(ctx, res);
    }
  }

  #fetch(ctx: FlareHttpContext, res: ServerResponse): void {
    try {
      const response = this.http.fetch(ctx);
      if (response instanceof Promise) {
        response.then(
          (resolved) => {
            this.#processResponse(res, resolved, ctx);
          },
          (error) => {
            this.#handleRequestError(res, error, ctx.req.requestId);
          },
        );
        return;
      }

      this.#processResponse(res, response, ctx);
    } catch (error) {
      this.#handleRequestError(res, error, ctx.req.requestId);
    }
  }

  #processResponse(res: ServerResponse, response: ResponseLike, ctx: FlareHttpContext): void {
    try {
      const writeResult = this.#writeResponse(res, response, ctx);
      if (writeResult instanceof Promise) {
        writeResult.catch((error) => {
          this.#handleRequestError(res, error, ctx.req.requestId);
        });
      }
    } catch (error) {
      this.#handleRequestError(res, error, ctx.req.requestId);
    }
  }

  #writeResponse(res: ServerResponse, response: ResponseLike, ctx: FlareHttpContext): void | Promise<void> {
    const requestId = ctx.req.requestId;
    const setCookies = ctx[DRAIN_SET_COOKIES]();

    if (response instanceof FlareResponse) {
      if (this.#emitRequestIdHeader) {
        (response.headers as Record<string, string>)["x-request-id"] = requestId;
      }

      // Build the writeHead headers. Node's OutgoingHttpHeaders accepts string[] values
      // for multi-value headers like Set-Cookie, so we can pass setCookies directly.
      const writeHeaders: Record<string, string | string[]> = setCookies
        ? { ...response.headers, "Set-Cookie": setCookies }
        : response.headers;

      // Streaming response
      if (response.bodyStream) {
        res.writeHead(response.status, writeHeaders);
        return (async () => {
          for await (const chunk of response.bodyStream!) {
            if (!res.write(chunk)) {
              await once(res, "drain");
            }
          }
          res.end();

          this.#settleRequest();
        })();
      }

      // Standard response
      res.writeHead(response.status, writeHeaders);
      res.end(response.body);
      this.#settleRequest();
      return;
    }

    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value: string, key: string) => {
      headers[key] = value;
    });
    if (this.#emitRequestIdHeader) {
      headers["x-request-id"] = requestId;
    }
    if (setCookies) {
      headers["Set-Cookie"] = setCookies;
    }

    res.writeHead(response.status, headers);

    res.statusCode = response.status;
    if (response.body === null) {
      res.end();
      this.#settleRequest();
      return;
    }

    return response.arrayBuffer().then((arrayBuffer: ArrayBuffer) => {
      res.end(Buffer.from(arrayBuffer));
      this.#settleRequest();
    });
  }

  #handleRequestError(res: ServerResponse, error: unknown, requestId: string): void {
    this.#settleRequest();

    this.host.logger.error(error, "Internal error");

    if (res.headersSent) {
      this.host.logger.warn("Connection destroyed after headers sent", {
        error: String(error),
      });
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }

    res.writeHead(
      500,
      this.#emitRequestIdHeader
        ? { "content-type": "application/json", "x-request-id": requestId }
        : { "content-type": "application/json" },
    );
    res.end('{"error":"Internal Server Error"}');
  }

  #settleRequest(): void {
    this.#activeRequests--;
    if (this.#activeRequests === 0 && this.#waitForActiveRequestsResolve) {
      this.#waitForActiveRequestsResolve();
      this.#waitForActiveRequestsResolve = undefined;
    }
  }

  #bindProcessHandlers(): void {
    this.#onSigterm = () => {
      this.host.logger.info("Received SIGTERM, shutting down gracefully.");
      this.#shutdown({ exitCode: 0, exitProcess: true });
    };
    process.once("SIGTERM", this.#onSigterm);

    this.#onSigint = () => {
      this.host.logger.info("Received SIGINT, shutting down gracefully.");
      this.#shutdown({ exitCode: 0, exitProcess: true });
    };
    process.once("SIGINT", this.#onSigint);

    // Use `on` (not `once`) so a second uncaught exception during shutdown
    // still reaches the logger. #shutdown is idempotent via #shutdownPromise.
    this.#onUncaught = (err, origin) => {
      this.host.logger.fatal(err, "Uncaught exception", {
        origin,
      });

      this.#shutdown({ exitCode: 1, exitProcess: true });
    };
    process.on("uncaughtException", this.#onUncaught);

    // Treat unhandled rejections as fatal: log diagnostics, drain in-flight
    // requests via #shutdown, then exit 1. Matches Node's own
    // --unhandled-rejections=strict default and surfaces broken third-party
    // promises rather than letting them silently rot.
    this.#onUnhandled = (reason) => {
      this.host.logger.fatal(reason, "Unhandled promise rejection");

      this.#shutdown({ exitCode: 1, exitProcess: true });
    };
    process.on("unhandledRejection", this.#onUnhandled);
  }

  /**
   * Removes the process-level handlers {@link #bindProcessHandlers} installed. Without this, every
   * run()/stop() cycle (an embedded host, a test suite of real servers) leaks four listeners that keep
   * the stopped app reachable - and a STOPPED app's uncaughtException handler could still fire
   * #shutdown/process.exit long after its owner discarded it.
   */
  #unbindProcessHandlers(): void {
    if (this.#onSigterm) process.off("SIGTERM", this.#onSigterm);
    if (this.#onSigint) process.off("SIGINT", this.#onSigint);
    if (this.#onUncaught) process.off("uncaughtException", this.#onUncaught);
    if (this.#onUnhandled) process.off("unhandledRejection", this.#onUnhandled);
    this.#onSigterm =
      this.#onSigint =
      this.#onUncaught =
      this.#onUnhandled =
        undefined;
  }

  #shutdown(options: NodeShutdownOptions): Promise<void> {
    this.#exitAfterShutdown ||= options.exitProcess;
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }

    this.#shutdownPromise = (async () => {
      this.#isShuttingDown = true;
      this.host[SET_HOST_STATE]("draining");

      // Close live WebSocket connections with 1001 (going away) so their sockets finish and
      // server.close() can complete; the per-connection close grace and the force-exit timer bound it.
      for (const conn of this.#wsConnections) {
        try {
          conn.close(1001, "Server shutting down");
        } catch {
          /* a connection already tearing down is fine to skip */
        }
      }
      this.host.logger.trace("Lifecycle event", {
        phase: "shutdown",
        component: "runtime",
        event: "start",
        runtime: "node",
        activeRequests: this.#activeRequests,
        exitCode: options.exitCode,
      });

      // Keep the listening socket open during drain so newly-arriving requests
      // are accepted and answered with the 503 / Connection: close response in
      // #handleIncomingRequest (which short-circuits before incrementing
      // #activeRequests, so the drain counter is not poisoned by them).
      // server.close() runs only after drain completes; that way the test
      // contract "new requests during drain return 503" is honoured rather
      // than producing connection-refused errors.
      let shutdownTimedOut = false;
      const forceExitTimer = setTimeout(() => {
        shutdownTimedOut = true;
        this.host.logger.fatal("Graceful shutdown timeout exceeded. Force-closing active connections.");
        this.#server?.closeAllConnections?.();
        if (this.#waitForActiveRequestsResolve) {
          this.#waitForActiveRequestsResolve();
          this.#waitForActiveRequestsResolve = undefined;
        }
        if (this.#exitAfterShutdown) process.exit(1);
      }, this.#shutdownTimeout);
      forceExitTimer.unref();

      const shouldLogDrain = this.#activeRequests > 0;
      const drainStart = shouldLogDrain ? Date.now() : 0;
      if (shouldLogDrain) {
        this.host.logger.trace("Lifecycle event", {
          phase: "shutdown",
          component: "runtime",
          event: "requests:drain:start",
          runtime: "node",
          activeRequests: this.#activeRequests,
        });
      }
      await this.#waitForActiveRequests();
      if (shouldLogDrain) {
        this.host.logger.trace("Lifecycle event", {
          phase: "shutdown",
          component: "runtime",
          event: "requests:drain:ready",
          runtime: "node",
          activeRequests: this.#activeRequests,
          durationMs: Date.now() - drainStart,
        });
      }
      await this.#closeServer();
      clearTimeout(forceExitTimer);

      let exitCode = shutdownTimedOut ? 1 : options.exitCode;

      try {
        await this.stopAsync();
      } catch (err) {
        exitCode = 1;
        this.host.logger.error(err, "Error during shutdown");
      }

      this.#unbindProcessHandlers();
      this.host[SET_HOST_STATE]("stopped");
      this.host.logger.trace("Lifecycle event", {
        phase: "shutdown",
        component: "runtime",
        event: "ready",
        runtime: "node",
        exitCode,
      });
      if (this.#exitAfterShutdown) process.exit(exitCode);
      if (shutdownTimedOut) {
        throw new Error(`Graceful shutdown timeout exceeded after ${this.#shutdownTimeout}ms.`);
      }
    })();

    return this.#shutdownPromise;
  }

  #waitForActiveRequests(): Promise<void> {
    if (this.#activeRequests === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.#waitForActiveRequestsResolve = resolve;
    });
  }

  #closeServer(): Promise<void> {
    const server = this.#server;
    if (!server?.listening) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const closeStart = Date.now();
      this.host.logger.trace("Lifecycle event", {
        phase: "shutdown",
        component: "runtime",
        event: "server:close:start",
        runtime: "node",
      });
      server.close((err) => {
        if (err) {
          this.host.logger.error(err, "Error while closing HTTP server");
        }
        this.host.logger.trace("Lifecycle event", {
          phase: "shutdown",
          component: "runtime",
          event: "server:close:ready",
          runtime: "node",
          durationMs: Date.now() - closeStart,
        });
        resolve();
      });
      server.closeIdleConnections?.();
    });
  }
}
