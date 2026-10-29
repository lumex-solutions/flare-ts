---
title: Naming
description: How names are formed: one meaning per word, interfaces and implementations, audience tiers for classes and types, factory and accessor names, siblings, and file names.
---

# Naming

The detail behind principle 4 of [organization](organization.md). A new name is reconciled against the nearest existing family before it is invented; consistency across siblings beats local preference.

## One word, one meaning

- A word names one concept across the code, its comments, and its docs. A second meaning takes a qualifier or a different word.
- A word retired from a concept stays retired. Reusing it for something else brings the old meaning back to every reader who knew it.

## Interfaces

- Interfaces are prefixed `I*` (`IFlareWebSocket`, `IValidator`, `IFlareHost`). The prefix marks the contract side of a seam.
- Implementations are named for their job (`NodeWebSocket`, `CfWebSocket` implement `IFlareWebSocket`), never for the interface they implement.
- No `Impl` suffix, and no suffix that restates the declaration keyword (`Interface`, `Type`).

## Classes and types: audience tiers

- `Flare*` - developer-held runtime objects (`FlareWebSocketContext`, `FlareResponse`).
- Fully spelled domain prefix - developer-facing types (`WebSocketRouteOptions`, `HttpGroup`).
- Short domain prefix - internals (`WsPipeline`, `WsChannelRegistry`, `HttpArc`).
- Bare concept names - services (`Container`); a developer-facing service spells its domain out (`WebSocketChannels`).

## Factories

- App-level declaration factories are flare-prefixed (`flareConfig`, `flareErrorCodes`, `flareState`): the developer is declaring something to the framework.
- Vocabulary factories are bare (`errorSchema`, `optional`, `defaultTo`): they mint a value of their own module's vocabulary.
- Arc shorthands spell their domain (`httpContract`, `socketContract`).

## Accessors

- An accessor's name states its gating semantics and never contradicts them: a gated view and its raw counterpart are named as such (`detail` returns only what `expose` permits; `rawDetail` returns everything). "Exposed" naming the ungated view is the counterexample.

## Siblings

- Two names that share a noun and differ in one property differ in one word, and that word names the property. Public pairs carry a stricter test in [surface](surface.md).

## Files

- Class modules: kebab-case of the class, by the rule in [file kinds](file-kinds.md).
- Operations and declarations modules: named for their concern.
- No file repeats its folder's name ([subsystems](subsystems.md)).
