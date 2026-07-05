/**
 * Scope types shared by every handler surface: the reserved `config` accessor and the DI + config base
 * each arc's handler scope extends. Arc-neutral on purpose - the HTTP and WS scopes both add their own
 * typed `input` on top of {@link FlareBaseScope}, and handlers that run outside any contract (HTTP
 * middleware and error handlers) receive exactly the base, since there is no typed input to add.
 */
import type { ConfigToken } from "../../config/flare-config.js";
import type { FlareService } from "../composition/flare-service.js";
import type { InjectedMap } from "./inject.js";
import type { ServiceToken } from "./types.js";

/** The scope's reserved `config` accessor: resolves a {@link ConfigToken} to its value. */
export type ScopeConfig = <T>(token: ConfigToken<T>) => T;

/**
 * The DI + config base of every handler scope: declared deps appear by name (lazily resolved), and
 * `config` resolves config tokens.
 */
export type FlareBaseScope<D extends Record<string, ServiceToken<FlareService>> = {}> =
  & { config: ScopeConfig; }
  & InjectedMap<D>;
