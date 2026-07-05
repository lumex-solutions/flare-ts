# Declaration placement

Where every declaration lives, by kind. One distinction settles every "can this file export X"
question - **signature vs vocabulary**:

- A **signature type** makes one module's own exported signatures nameable: the param and return
  shapes of its exported functions, or the member types of its exported class. Other files import
  it only to call or hold what this module exports.
- **Vocabulary** is everything else: shapes other modules consume for their own purposes, grammar
  developers spell in their code, contracts multiple modules implement or accept.

## Types

A signature type lives in the module whose signatures it serves, above the owner (`WsAttachment`
with the attachment operations, `WsDriverAccess` with the arc class whose seam member returns it).
Vocabulary lives in a declarations module (`WsPipeline` in `pipeline/route.ts`; the route-options
grammar in `composition/types/route-options.ts`, not in `base.ts` just because `route()` mentions
it - developers name those types, which makes them vocabulary). The class-shape type of a class
module's own class (`WebSocketControllerClass`) counts as that class's signature. When a signature
type gains an independent second consumer, it has become vocabulary: move it.

**Slice types.** A public type describing the deliberate narrow face of richer internal machinery
(`WebSocketState` exposes only `get`/`set` of the stores behind `ws.state`). A slice is a `type`
owned by the public surface that exposes it. The internal classes behind it never name it: no
`implements`, no import - the class is just itself, with its full internal surface. Conformance is
checked structurally at the boundary where an instance enters the public-facing slot (the typed
constructor parameter or field), which is the real contract site; drift fails there.

## Interfaces

`implements` is reserved for interfaces: a class either implements a named `I*` seam contract, or
it is just a class whose shape is checked structurally where it is used (see slice types above).
A class never `implements` a type alias.

Same placement as types, plus two rules. An interface exists only when something implements it
(at least one `implements` clause in src, or platform objects / test fakes standing in for it);
otherwise it is a `type` - bivariant method slots work in type aliases, and there is no
public-face exception: a developer-held object returned by the public surface is an exported
class (`HttpGroup`, `WebSocketRouteHandle`), exported type-only from the package index when it
must not be constructed by callers. And a contract's home is the subsystem that CONSUMES it, never
an implementation: `IWsChannelDomain` lives in `channels/domain.ts`, not beside any of its three
implementations; `IFlareWebSocket` lives in `transport/types/`, not beside `NodeWebSocket`. The
port belongs to the consumer.

## Functions

An exported function lives in an operations module - never in a class module or a declarations
module. One exception: a declarations module may export factory functions that construct values
of its own declared types (`socketContract`, `flareState`); the factory is part of the
vocabulary. Unexported functions follow the subordination rule in
[file-kinds.md](file-kinds.md).

Method vs module function is decided by state access: an instance method if and only if it reads
or writes `this`; `static` is reserved for construction-adjacent factories that must be reachable
through the class (`HibernationChannelIndex.for(state)`). A static that never touches the class is
a module function wearing a badge. (Performance is not the criterion: V8 inlines all forms in hot
code, and module-level is never worse in cold code, so the state-access rule is also the fast
choice.)

## Constants

An exported constant is domain vocabulary and lives in the declarations or operations module of
its domain (`WS_CLOSE` in `protocol.ts`, config defaults in `flare-config.ts`) - never in a class
module, never with its callers. Unexported constants sit above their first use.

## Unique symbols

A symbol lives with the declaration it keys, full stop. Keying a class's seam members: that class
module (`UPGRADE_WS` in `ws-arc.ts`). Keying a contract or brand: the declarations module holding
that contract (`WS_SEND_RAW` in `channels/domain.ts`, `CONTRACT_BRAND` in `contract.ts`). Never a
grab-bag symbols module.
