# File kinds

Every file is exactly one kind, declared by what it exports; mixing kinds is the violation. Rules
are mechanical - for any file there is exactly one legal shape, derivable without taste.

## The three kinds

- **Class module** - exactly one exported class; the filename is the kebab-case of that class,
  minus any leading segments the file's own folder path already spells: `NodeWebSocket` in
  `runtime/node/` is `web-socket.ts`, `WsChannelRegistry` in `arcs/ws/channels/` is
  `registry.ts`, but `HibernationChannelIndex` in `runtime/cloudflare/` keeps
  `hibernation-channel-index.ts` (no path segment spells it).
- **Operations module** - exported functions over one concern; named for the concern, not a
  function (`build.ts`, `codec.ts`, `ops.ts`, `handshake.ts`). Never exports a class.
- **Declarations module** - types, interfaces, brands, symbols, constants: the vocabulary of a
  subsystem (`pipeline/route.ts`, `channels/domain.ts`, `contract/ws-contract.ts`). Lives under a
  `types/` or `contract/` folder, or is the vocabulary file of its subsystem folder (see
  [subsystems.md](subsystems.md)).

What each kind may co-export is settled per declaration kind in
[declarations.md](declarations.md).

## Subordination

Uniform across kinds: an unexported helper (function, const, type, mini-class) with exactly one
consumer lives below that consumer in the same file. The moment it is exported or gains a second
consumer file, it moves to the module its kind dictates. Never import a helper from a file owned
by something else.

## Ordering inside a file

File JSDoc, imports, the owner's signature types, consts, the owner, then subordinate helpers.
The reader meets the API before the machinery.

## Scope

These rules bind `src/`. Test code follows the same spirit (helpers are operations modules,
fixtures are declarations) but is not held to the file-kind letter.
