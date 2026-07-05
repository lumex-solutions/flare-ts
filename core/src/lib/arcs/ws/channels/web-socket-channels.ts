/**
 * Framework service for publishing to WebSocket channels from outside a connection (HTTP handlers, timers, etc.).
 */

import type { Container } from "../../../services/container.js";
import type { IWsChannelDomain } from "./domain.js";
import { FlareService } from "../../../services/composition/flare-service.js";

/**
 * Framework service for publishing to WebSocket channels from OUTSIDE a connection: an HTTP handler, a
 * timer, any code in the same broadcast domain. Inject it like any service; each execution context
 * seeds the instance bound to ITS OWN domain, so the same handler code publishes correctly everywhere:
 * - Node: the host process's channel registry (the domain every Node WS connection joins).
 * - Durable Object instance: that instance's unified channel index (resident + hibernating connections).
 * - Plain Cloudflare Worker: NO domain exists (workerd pins each connection to the request that
 *   accepted it), so `host.build()` fails when a front-door route can reach this service, and the
 *   seeded backstop throws the same guidance at runtime.
 *
 * The bytes are sent raw: a cross-context publisher has no route `outgoing` schema, so a channel's
 * message shape is the domain-wide convention you own.
 *
 * @example
 * host.http.post("/rooms/announce", { inject: { channels: WebSocketChannels } }, (ctx, scope) => {
 *   scope.channels.publish("lobby", "server-announcement");
 *   return new FlareResponse(204);
 * });
 */
export class WebSocketChannels extends FlareService {
  static deps = [] as const;

  readonly #backend: IWsChannelDomain;

  /**
   * @param container - The service container for dependency resolution.
   * @param backend - Optional only to satisfy {@link FlareServiceClass}'s one-argument construct signature; every real instance is seeded by a runtime adapter with its context's broadcast domain, and absence fails loudly at construction rather than silently publishing nowhere.
   */
  constructor(container: Container, backend?: IWsChannelDomain) {
    super(container);
    if (!backend) {
      throw new Error(
        "[flare] WebSocketChannels is seeded by the runtime adapter with its context's broadcast domain; do not construct or register it yourself.",
      );
    }
    this.#backend = backend;
  }

  /**
   * Publishes `message` to every connection subscribed to `channel` in this context's broadcast domain.
   *
   * @throws {Error} When this context has no broadcast domain (the plain-Worker case above).
   */
  publish(channel: string, message: string | Uint8Array): void {
    this.#backend.publish(channel, message);
  }
}
