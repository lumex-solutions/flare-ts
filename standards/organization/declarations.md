---
title: Declaration placement
description: Where every declaration lives, by kind, settled by one distinction: signature or vocabulary.
---

# Declaration placement

The detail behind principle 3 of [organization](organization.md). One distinction settles every "can this file export X" question, **signature vs vocabulary**:

- A **signature type** makes one module's own exported signatures nameable: the param and return shapes of its exported functions, or the member types of its exported class. Other files import it only to call or hold what this module exports.
- **Vocabulary** is everything else: shapes other modules consume for their own purposes, grammar developers spell in their code, contracts multiple modules implement or accept.

## Types

A signature type lives in the module whose signatures it serves, above the owner (`WsAttachment` with the attachment operations, `WsDriverAccess` with the arc class whose seam member returns it). Vocabulary lives in a declarations module: the route-options grammar lives in its own declarations module, not in the base class just because `route()` mentions it, since developers name those types, which makes them vocabulary. The class-shape type of a class module's own class counts as that class's signature. When a signature type gains an independent second consumer, it has become vocabulary: move it.

**The vocabulary ladder.** Which declarations module vocabulary lives in is an escalation, not a choice of taste:

1. A signature type lives beside its owner (the rule above).
2. Vocabulary with a single producing concern lives in that concern's declarations module (`ws-contract.ts`, `flare-state.ts`), typically alongside its own-vocabulary factory.
3. Vocabulary shared across a subsystem's modules with no single owner lives in one `<subsystem>/types.ts`. A `types.ts` is function-free: factories and readers live at rungs 2 and 4 of their own ladders.
4. When that shared vocabulary itself splits into distinct concerns, it earns a `types/` folder of concern-named files (`composition/types/route-options.ts`). Never a `types.ts` inside a `types/` folder: that is the banned folder-name repetition. `types/`, like `contract/`, is the sanctioned exception to the ban on folders by kind.

Descend the ladder as eagerly as you climb it: a `types/` folder down to one file dissolves to rung 3; a lone vocabulary file whose every importer also imports the rung-2 module folds into it, since a standalone file is earned by consumers that use it independently.

**Slice types.** A public type describing the deliberate narrow face of richer internal machinery, such as a state view that exposes only `get` and `set` of the stores behind it. A slice is a `type` owned by the public surface that exposes it. The internal classes behind it never name it: no `implements`, no import; the class is just itself, with its full internal surface. Conformance is checked structurally at the boundary where an instance enters the public-facing slot (the typed constructor parameter or field), which is the real contract site; drift fails there.

## Interfaces

An interface exists only where [structure](../code/structure.md) allows a seam; otherwise the shape is a `type`, since bivariant method slots work in type aliases. When it exists, a contract's home is the subsystem that consumes it, never an implementation: the channel-domain contract lives with the channels that consume it, not beside any of its implementations, and the socket contract lives with the transport's types, not beside the Node socket. The contract belongs to the consumer.

## Functions

An exported function lives in an operations module, never in a class module or a declarations module. One exception: a declarations module may export factory functions that construct values of its own declared types (`socketContract`, `flareState`); the factory is part of the vocabulary. Unexported functions follow the subordination rule in [file kinds](file-kinds.md). Whether a function is a method or a module function is [structure](../code/structure.md).

## Constants

An exported constant is domain vocabulary and lives in the declarations or operations module of its domain (`WS_CLOSE` with the wire protocol, config defaults with the config declaration), never in a class module, never with its callers. Unexported constants sit above their first use.

## Unique symbols

A symbol lives with the declaration it keys. Keying a class's seam members: that class module (`UPGRADE_WS` with the arc class). Keying a contract or brand: the declarations module holding that contract (`CONTRACT_BRAND` with the contract). Never a grab-bag symbols module.
