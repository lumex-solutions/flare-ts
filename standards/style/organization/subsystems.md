# Subsystems

Folders are subsystems. A folder exists for exactly one reason: a cohesive concern spanning two or
more modules (its producer, its operations, its declarations). A one-module concern is a file at
its layer root; it earns a folder only when it grows a second module, and the folder is named for
the concern. No folders-by-kind (`utils/`, `helpers/`): kinds are file shapes (see
[file-kinds.md](file-kinds.md)), concerns are folders.

## Runtime-specific modules live under runtime/

A subsystem's root holds only portable concerns. Modules specific to one runtime live under
`runtime/<runtime>/` inside the subsystem (`host/runtime/cloudflare/`,
`ws/transport/runtime/node/`, `logger/runtime/cloudflare/`), one folder per runtime, named for
the runtime. A runtime variant of a root concern extends the portable module; it never sits
beside it.

## Placement follows the data, not the caller

An operations module lives in the subsystem folder of the data it operates on, next to that
data's producer and declarations; consumers import across the subsystem boundary. Example:
operations over the compiled pipeline live in `pipeline/` beside `build.ts` (which produces
pipelines); the connection and the hibernation drivers are consumers and stay outside.

## A subsystem owns its declarations

Its vocabulary module lives inside its folder. A layer-root `types/` folder holds only shapes
belonging to no subsystem; when everything in it belongs to one subsystem, it dissolves into that
subsystem's folder.

## No prefixes inside a folder

Files inside a subsystem folder are not prefixed with the IMMEDIATE folder's own name
(`pipeline/build.ts`, never `pipeline/pipeline-build.ts`); the folder is the context. Prefixes
spelling other context (an arc tier like `ws-`) are governed by the class-kebab rule in
[file-kinds.md](file-kinds.md), not banned here.

## Reference layout (the WS arc)

```
ws/
  ws-arc.ts, connection.ts   single-module concerns at the layer root (class modules)
  composition/               authoring subsystem: base.ts, classes/, contract/, types/
  pipeline/                  compiled-route subsystem: build.ts, ops.ts, route.ts, input.ts
  channels/                  pub/sub subsystem: domain.ts, registry.ts, web-socket-channels.ts
  transport/                 socket subsystem: socket.ts, wire/, runtime/<platform>/
```
