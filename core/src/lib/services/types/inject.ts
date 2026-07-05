import type { Injected } from "../composition/flare-base.js";
import type { FlareService } from "../composition/flare-service.js";
import type { ServiceToken } from "./types.js";

/**
 * Resolved-instance map derived from a declared `inject` token map.
 *
 * The reserved `config` key (carried as an optional `never` on {@link InjectMap}) is excluded so it
 * never collides with the scope's `config` accessor.
 */
export type InjectedMap<D extends Record<string, ServiceToken<FlareService>>> = {
  [K in keyof D as K extends "config" | "input" ? never : K]: D[K] extends ServiceToken<infer T> ? Injected<T>
    : never;
};

/**
 * `inject` declaration map. `config` and `input` are reserved (they are the scope's config accessor
 * and parsed-request accessor).
 */
export type InjectMap = Record<string, ServiceToken<FlareService>> & { config?: never; input?: never; };
