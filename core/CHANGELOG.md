# @flare-ts/core

## 0.3.0

### Minor Changes

- Add a request extension API. Extensions self-register per runtime at module load via `registerRequestExtension` and hook each request through `onRequest` to augment `FlareRequest` with typed fields. No host wiring or `declare module` for app devs. Registered extensions surface in the `inspectBuild` snapshot as `requestExtensions`.

- Add `durableCf`/`buildDurableCf` Durable Object adapter alongside `cf`/`buildCf`, built on the extension API: the Cloudflare extension adds `req.runtime`, threading the Worker `env` into `req.runtime.bindings` and the DO `ctx` into `req.runtime.durable`. No setup needed. Importing any adapter from `@flare-ts/core/cloudflare` auto-registers the extension, so handlers can read `req.runtime` directly.

### Patch Changes

- Abort the CF streaming-response writer on a body-stream error instead of hanging
- @flare-ts/lib@0.3.0

## 0.2.0

### Minor Changes

- 493db9c: Export `stream` primitive from @flare-ts/core
  Refactored FlareRequest.stream() to enforce `maxBodyBytes`

### Patch Changes

- 92ddc88: Fixed log.enableContext config to work on CF runtime.
  Added `captureLogStore` and `runWithLogStore` helpers for background/waitUntil context support
- Updated dependencies [f3f8110]
  - @flare-ts/lib@0.2.0
