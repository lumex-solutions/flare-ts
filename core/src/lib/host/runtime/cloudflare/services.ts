import type { Container } from "../../../services/container.js";
import { FlareService } from "../../../services/composition/flare-service.js";

/**
 * Framework service exposing the Cloudflare Worker `env` bindings to an injecting {@link FlareService}.
 *
 * @example
 * class RoomService extends FlareService {
 *   static deps = [Bindings] as const;
 *   #kv = this.inject(Bindings).env.MY_KV;
 * }
 */
export class Bindings extends FlareService {
  static deps = [] as const;

  constructor(
    container: Container,
    /** The isolate's (or instance's) Cloudflare `env` bindings. */
    public readonly env: Cloudflare.Env,
  ) {
    super(container);
  }
}

/**
 * Framework service exposing a Durable Object's `DurableObjectState` (`ctx`) as a per-instance singleton.
 *
 * Seeded per Durable Object instance by `composeDurableInstance`; a stateless Worker has no instance state to expose.
 *
 * @example
 * class RoomService extends FlareService {
 *   static deps = [DurableState] as const;
 *   #sql = this.inject(DurableState).storage.sql;
 * }
 */
export class DurableState extends FlareService {
  static deps = [] as const;

  constructor(container: Container, public readonly state: DurableObjectState) {
    super(container);
  }

  /** The instance's durable storage (`ctx.storage`), including the SQL API. */
  get storage(): DurableObjectStorage {
    return this.state.storage;
  }

  /** The instance's Durable Object id (`ctx.id`). */
  get id(): DurableObjectId {
    return this.state.id;
  }
}
