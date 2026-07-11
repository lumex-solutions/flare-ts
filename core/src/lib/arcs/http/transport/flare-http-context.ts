/**
 * The full HTTP context handlers receive: the inbound request, per-request state,
 * contract extraction, SSE, and the cookie accessor, plus the arc's internal seams.
 */
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { DeepReadonly, StateGetter, StateToken, TypedStateToken } from "../../../state/flare-state.js";
import type { RequestDescriptor } from "../composition/contract/http-contract.js";
import type { CookieSigner } from "./cookie-signer.js";
import type { FlareRequest } from "./flare-request.js";
import type { SseEvent, SseWriter } from "./sse.js";
import type { RequestContext, TypedRequestContext } from "./types/request-context.js";
import type { ResponseSerializers, Serializer } from "./types/response.js";
import { loggerALS } from "../../../logger/context.js";
import { StateMap } from "../../../state/map.js";
import { getTokenDefault, getTokenDerivation, getTokenLogMapper } from "../../../state/read.js";
import { FlareCookies } from "./flare-cookies.js";
import { FlareResponse } from "./flare-response.js";
import { encodeSseComment, encodeSseEvent, SseStream } from "./sse.js";
import { COOKIE_SIGNER, DRAIN_SET_COOKIES } from "./types/cookies.js";

/** @internal */
export const SET_REQ_CTX: unique symbol = Symbol("SET_REQ_CTX");
/** @internal */
export const SET_PARSED_BODY: unique symbol = Symbol("SET_PARSED_BODY");
/** @internal */
export const INSTANCE_SINGLETONS: unique symbol = Symbol("INSTANCE_SINGLETONS");
/**
 * Neutral internal accessor: returns the populated parsed request context (the same `#requestCtx`
 * that {@link FlareHttpContext.extract} returns) WITHOUT the descriptor-identity guard. Used to seed
 * the handler scope's `input` so inline routes read `{ body, route, query }` directly. Returns an
 * empty object when no inputs were parsed for this request.
 *
 * @internal
 */
export const REQUEST_INPUT: unique symbol = Symbol("flare.requestInput");
/**
 * Neutral internal accessor: returns the RAW stored value for a token directly from the
 * underlying state map, WITHOUT going through `#resolve` (so no `.withDefault()`/`.from()`
 * derivation fires and nothing is written back). Returns `undefined` for any token the
 * request never explicitly set. No DO/CF semantics; a generic peek used by host extensions
 * that need only-explicitly-present state.
 *
 * @internal
 */
export const PEEK_STATE: unique symbol = Symbol("flare.peekState");
/**
 * Signals that the pipeline entered the error branch. Set by the exec-codegen error
 * dispatch path on any before/handler/after/finally error exit. Consumers may use
 * this flag to suppress error-path side effects (for example, skipping outbound
 * encodings that should only run on the success path).
 *
 * @internal
 */
export const HANDLER_ERRORED: unique symbol = Symbol("flare.handlerErrored");

type RequestState = {
  set: <T>(token: TypedStateToken<T>, value: T) => void;
  get: <T>(token: TypedStateToken<T>) => DeepReadonly<T> | undefined;
  require: <T>(token: TypedStateToken<T>) => DeepReadonly<T>;
};

// Contract-less routes read an empty input every request; reuse one frozen object rather than
// allocating `{}` per read. Frozen so a stray write can never leak across requests.
const EMPTY_REQUEST_CTX: RequestContext = Object.freeze({}) as RequestContext;

/**
 * Full HTTP context passed to controllers, middleware, and handler functions.
 *
 * Wraps the inbound {@link FlareRequest} (available as {@link req}) and exposes
 * pipeline-scoped concerns: request state, parsed contract data via {@link extract},
 * and outbound cookie management via {@link cookies}.
 */
export class FlareHttpContext {
  readonly req: FlareRequest;

  /**
   * @internal Per-invocation singleton map, set by a runtime or host extension so the http arc
   * resolves a specific exported instance's own singletons. Undefined by default, in which case the
   * module-level singletons are used.
   */
  [INSTANCE_SINGLETONS]?: ReadonlyMap<ServiceToken<FlareService>, FlareService>;

  /** @internal Cookie signer for this request, stamped by the HTTP arc when a secret is configured. */
  [COOKIE_SIGNER]?: CookieSigner;

  /**
   * @internal
   * Returns the RAW stored value for a token (only-explicitly-present), bypassing `#resolve`
   * so no default/derivation is fired or written back. See {@link PEEK_STATE}.
   */
  [PEEK_STATE]<T>(token: TypedStateToken<T>): DeepReadonly<T> | undefined {
    return this.#stateMap?.get(token);
  }

  #stateMap: StateMap | undefined;
  #state: RequestState | undefined;
  #derivingTokens: Set<StateToken> | undefined;

  #requestCtx: RequestContext | undefined;
  #requestDescriptor: RequestDescriptor | undefined;
  #responseSerializers: ResponseSerializers | undefined;

  #cookies: FlareCookies | undefined;

  constructor(req: FlareRequest) {
    this.req = req;
  }

  get state(): RequestState {
    return (this.#state ??= {
      require: <T>(token: TypedStateToken<T>): DeepReadonly<T> => {
        const value = this.#resolve(token);
        if (value === undefined) throw new Error(`StateToken ${token.name} not found in FlareHttpContext state.`);
        return value;
      },

      get: <T>(token: TypedStateToken<T>): DeepReadonly<T> | undefined => {
        return this.#resolve(token);
      },

      set: <T>(token: TypedStateToken<T>, value: T): void => {
        if (!this.#stateMap) this.#stateMap = new StateMap();
        this.#stateMap.set(token, value);
        this.#stampState(token);
      },
    });
  }

  get cookies(): FlareCookies {
    return (this.#cookies ??= new FlareCookies(this));
  }

  /**
   * Opens a Server-Sent Events response and runs `producer` as the event source.
   *
   * The response returns immediately with `Content-Type: text/event-stream`; the
   * producer pushes frames through the {@link SseWriter}, which paces itself
   * against the connection (one frame buffered). The stream ends when the
   * producer settles or the request aborts; the producer's `signal` is the
   * request's `AbortSignal`, so a long-lived loop can stop when the client leaves.
   *
   * @example
   * ```ts
   * return ctx.sse(async (sse, signal) => {
   *   while (!signal.aborted) {
   *     await sse.send({ event: "tick", data: { now: Date.now() } });
   *     await delay(1000);
   *   }
   * });
   * ```
   */
  sse(producer: (sse: SseWriter, signal: AbortSignal) => void | Promise<void>): FlareResponse {
    const stream = new SseStream();
    const signal = this.req.signal;
    const writer: SseWriter = {
      send: (event: SseEvent) => stream.push(encodeSseEvent(event)),
      comment: (text: string) => stream.push(encodeSseComment(text)),
    };

    if (signal.aborted) {
      stream.close();
    } else {
      const onAbort = (): void => stream.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      // Runs un-awaited: the response is returned now and frames stream out as the
      // producer pushes them. When it settles (or the request aborts) the stream
      // closes and the transport ends the response.
      void (async () => {
        try {
          await producer(writer, signal);
        } finally {
          signal.removeEventListener("abort", onAbort);
          stream.close();
        }
      })();
    }

    return new FlareResponse(200, stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  /**
   * Extracts the parsed and validated request inputs typed against a contract descriptor.
   *
   * Pass a single method entry from a {@link ContractToken} and receive an object
   * whose `body`, `route`, and `query` properties are fully typed according to what
   * the descriptor declares. Fields not present in the descriptor resolve to `never`.
   *
   * Zero-cost cast at runtime: no additional parsing is performed.
   * Parsing and validation happen once in the pipeline before the handler runs.
   *
   * @example
   * ```ts
   * const { body, route, query } = ctx.extract(UserContract.getUser);
   * ```
   */
  extract<T extends RequestDescriptor>(descriptor: T): TypedRequestContext<T> {
    if (this.#requestDescriptor === undefined) {
      throw new Error(
        "[flare] ctx.extract() was called on a handler that has no contract. Ensure the controller has a contract and this method is declared in it.",
      );
    }
    if (descriptor !== this.#requestDescriptor) {
      throw new Error(
        "[flare] ctx.extract() was called with a descriptor that does not match the current handler. Are you passing the wrong method from your contract?",
      );
    }
    // The typed-recovery point of the contract pairing: the identity check above proved `descriptor`
    // IS the descriptor this request's inputs were parsed against, so the loose RequestContext values
    // are exactly the shapes T declares - a fact the erased storage cannot state.
    return (this.#requestCtx ?? EMPTY_REQUEST_CTX) as unknown as TypedRequestContext<T>;
  }

  /**
   * @internal
   * Returns the populated parsed request context directly, bypassing the descriptor-identity guard
   * that {@link extract} enforces. Reads the same `#requestCtx`. See {@link REQUEST_INPUT}.
   */
  [REQUEST_INPUT](): RequestContext {
    return this.#requestCtx ?? EMPTY_REQUEST_CTX;
  }

  /**
   * @internal
   * Returns the pre-compiled serializer for the given (methodIdx, status), or
   * undefined. Currently unused — the response serializer lookup lives in
   * normalizeHandlerResult / the exec-codegen inline fast path. Retained for
   * the public API surface; takes methodIdx now that the underlying map is
   * indexed by methodIdx first.
   */
  serializer(methodIdx: number, status: number): Serializer | undefined {
    const perStatus = this.#responseSerializers && this.#responseSerializers[methodIdx];
    return perStatus && perStatus[status];
  }

  [SET_REQ_CTX](
    body?: RequestContext["body"],
    route?: RequestContext["route"],
    query?: RequestContext["query"],
    responseSerializers?: ResponseSerializers,
    descriptor?: RequestDescriptor,
  ): void {
    if (descriptor !== undefined) this.#requestDescriptor = descriptor;

    if (body !== undefined || route !== undefined || query !== undefined) {
      const requestCtx: RequestContext = this.#requestCtx ?? {};
      if (body !== undefined) requestCtx.body = body;
      if (route !== undefined) requestCtx.route = route;
      if (query !== undefined) requestCtx.query = query;
      this.#requestCtx = requestCtx;
    }

    if (responseSerializers !== undefined) this.#responseSerializers = responseSerializers;
  }

  /**
   * @internal
   * Narrow setter used by the body-validation step in `prepareRequestBody`.
   * Only writes the body field; leaves route/query/descriptor/serializers untouched.
   */
  [SET_PARSED_BODY](body: RequestContext["body"] | null): void {
    // Preserves SET_REQ_CTX semantics on FlareHttpContext: an empty inbound
    // body becomes `body: null` on extract(), not `undefined`. JsonValue includes
    // null, so assignment is type-safe: only the `undefined` arm is filtered.
    if (body === undefined) return;
    const requestCtx: RequestContext = this.#requestCtx ?? {};
    requestCtx.body = body;
    this.#requestCtx = requestCtx;
  }

  /**
   * @internal
   * Drains the accumulated outbound `Set-Cookie` strings for the runtime adapter.
   * Returns `null` when no cookies were set during this request (the common case),
   * letting the runtime fast-path skip the append entirely.
   */
  [DRAIN_SET_COOKIES](): string[] | null {
    return this.#cookies ? this.#cookies[DRAIN_SET_COOKIES]() : null;
  }

  #resolve<T>(token: TypedStateToken<T>): DeepReadonly<T> | undefined {
    if (!this.#stateMap) this.#stateMap = new StateMap();
    const _state = this.#stateMap;

    const stored = _state.get(token);
    if (stored !== undefined) return stored;

    const derivation = getTokenDerivation(token);
    if (derivation !== undefined) {
      if (!this.#derivingTokens) this.#derivingTokens = new Set();
      const dt = this.#derivingTokens;
      if (dt.has(token)) {
        throw new Error(
          `[flare] Circular state derivation detected for token "${token.name}". Check that your .from() functions do not require each other.`,
        );
      }
      dt.add(token);
      try {
        const computed = this.#runDerivation(token, derivation);
        if (computed !== undefined) {
          _state.set(token, computed);
          this.#stampState(token);
          return _state.get(token)!;
        }
      } finally {
        dt.delete(token);
      }
    }

    const defaultVal = getTokenDefault(token);
    if (defaultVal !== undefined) {
      _state.set(token, defaultVal);
      this.#stampState(token);
      return _state.get(token)!;
    }

    return undefined;
  }

  /** Invokes a token's `.from()` derivation, anchoring a throw to the token; the original error rides on `cause`. */
  #runDerivation<T>(token: TypedStateToken<T>, derivation: (ctx: StateGetter) => T): T {
    try {
      return derivation(this);
    } catch (err) {
      throw new Error(
        `[flare] State derivation for token "${token.name}" threw: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  #stampState<T>(token: TypedStateToken<T>): void {
    const mapper = getTokenLogMapper(token);
    if (!mapper || !this.#stateMap) return;

    const store = loggerALS.getStore();
    if (!store) return;

    const value = this.#stateMap.get(token);
    if (value === undefined) return;

    const mapped = mapper(value);
    let state = store.state;
    for (const [key, mappedValue] of Object.entries(mapped)) {
      if (mappedValue === undefined) continue;
      (state ??= store.state = {})[key] = mappedValue;
    }
  }
}
