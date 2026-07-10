/**
 * `@flare-ts/core/cloudflare`: the Cloudflare Workers runtime surface, plus the
 * white-box Durable Object testing helpers (in-process DO composition and
 * KV-only fakes). Requires a Workers environment: {@link FlareDurableObject}
 * imports `cloudflare:workers` at module scope.
 */

export {
  Bindings,
  buildCf,
  cf,
  durable,
  DurableState,
  FlareDurableObject,
} from "./lib/host/runtime/cloudflare/index.js";
export type {
  CloudflareAdapter,
  DurableAddressingOpts,
  DurableStub,
  FlareAppCF,
  WorkerExportedHandle,
} from "./lib/host/runtime/cloudflare/index.js";

// White-box DO testing: drive the real per-instance container graph without
// miniflare or workerd bindings. Pure helpers; tree-shaken out of production
// bundles (`sideEffects: false`).
export {
  composeDurableInstance,
  makeEnv,
  makeFakeDurableState,
  makeFakeStorage,
} from "./lib/host/runtime/cloudflare/index.js";
