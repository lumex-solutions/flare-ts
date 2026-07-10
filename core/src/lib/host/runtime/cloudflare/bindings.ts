/**
 * The framework service exposing Worker env bindings to injecting services.
 */
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
