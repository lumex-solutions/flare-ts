# Naming

Reconcile a new name against the nearest existing family before inventing one; consistency across
siblings beats local preference.

## Interfaces

- Interfaces are prefixed `I*` (`IFlareWebSocket`, `IValidator`, `IFlareHost`).
- The prefix marks the contract side of a seam. Implementations are named for their job
  (`NodeWebSocket`, `CfWebSocket` implement `IFlareWebSocket`), never for the interface they
  implement.

## Classes and types: audience tiers

- `Flare*` - developer-held runtime objects (`FlareWebSocketContext`, `FlareResponse`).
- Fully spelled domain prefix - developer-facing types (`WebSocketRouteOptions`, `HttpGroup`).
- Short domain prefix - internals (`WsPipeline`, `WsChannelRegistry`, `HttpArc`).
- Bare concept names - services (`Container`); a developer-facing service spells its domain out
  (`WebSocketChannels`).

## Factories

- App-level declaration factories are flare-prefixed (`flareConfig`, `flareErrorCodes`,
  `flareState`): the developer is declaring something to the framework.
- Vocabulary factories are bare (`errorSchema`, `optional`, `defaultTo`): they mint a value of
  their own module's vocabulary.
- Arc shorthands spell their domain (`httpContract`, `socketContract`).

## Accessors

- An accessor's name states its gating semantics and never contradicts them: a gated view and
  its raw counterpart are named as such (`detail` returns only what `expose` permits;
  `rawDetail` returns everything). "Exposed" naming the UNGATED view is the counterexample.

## Files

- Class modules: kebab-case of the class.
- Operations and declarations modules: named for their concern.
- See [file-kinds.md](file-kinds.md).
