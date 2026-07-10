/**
 * The framework service exposing a Durable Object's state to injecting services.
 */
import type { Container } from "../../../../services/container.js";
import { FlareService } from "../../../../services/composition/flare-service.js";

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
