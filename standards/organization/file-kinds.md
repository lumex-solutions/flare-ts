---
title: File kinds
description: The three kinds a file can be, what each exports and is named, what a module exports at all, where unexported helpers live, and the order inside a file.
---

# File kinds

The detail behind principle 1 of [organization](organization.md). Every file under `src/` is exactly one kind, declared by what it exports; mixing kinds is the violation. For any file there is exactly one legal shape, derivable without taste.

## The three kinds

- **Class module** - exactly one exported class; the filename is the kebab-case of that class, minus any leading segments the file's own folder path already spells: `NodeWebSocket` in `runtime/node/` is `web-socket.ts`, `WsChannelRegistry` in `arcs/ws/channels/` is `registry.ts`, but `HibernationChannelIndex` in `runtime/cloudflare/` keeps `hibernation-channel-index.ts`, since no path segment spells it. When the stripped name would shadow a module at the subsystem root, the file keeps the full class kebab: `CfLogger` in `logger/runtime/cloudflare/` is `cf-logger.ts` because `logger/logger.ts` is a root module. Sibling collisions across runtime folders are fine (`runtime/node/web-socket.ts` and `runtime/cloudflare/web-socket.ts` read as one concern per runtime); shadowing an ancestor is not.
- **Operations module** - exported functions over one concern, named for the concern, not a function (`build.ts`, `codec.ts`, `ops.ts`, `handshake.ts`). Never exports a class.
- **Declarations module** - types, interfaces, brands, symbols, constants: the vocabulary of a subsystem (`channels/domain.ts`, `contract/ws-contract.ts`). Lives under a `types/` or `contract/` folder, or is the vocabulary file of its subsystem folder; which home is settled by the vocabulary ladder in [declarations](declarations.md).

What each kind may co-export is settled per declaration kind in [declarations](declarations.md).

## Exports

- A module exports what its consumers use and nothing else.
- A symbol exported only so a test can reach it carries `@internal`, and its existence is a finding to revisit: the test should reach the behavior through what the module's consumers use. A symbol-keyed seam a sibling driver holds, such as `UPGRADE_WS`, carries `@internal` too, and is not such a finding: it is the declared contract the driver holds.

## Subordination

Uniform across kinds: an unexported helper (function, const, type, mini-class) with exactly one consumer lives below that consumer in the same file. The moment it is exported or gains a second consumer file, it moves to the module its kind dictates. A helper is never imported from a file owned by something else.

## Ordering inside a file

File header, imports, the owner's signature types, consts, the owner, then subordinate helpers. The reader meets the API before the machinery.

## Scope

These rules bind `src/`. Test code follows the same spirit (helpers are operations modules, fixtures are declarations) but is not held to the file-kind letter.
