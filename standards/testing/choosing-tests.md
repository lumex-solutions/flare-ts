---
title: Choosing a test
description: Which test to write: the runtime root, the tier, the rules each tier holds, and the two styles of Durable Object test.
---

# Choosing a test

The detail behind principles 2 and 4 of [testing](testing.md): which test to write, and the tier rules that decide it.

## The decision path

Two questions place every test: which runtime root, then which tier.

**Root**: does the claim name a specific runtime's behavior, such as node streams and sockets, or workerd and Durable Objects? Then that runtime's root, using its adapter and helpers. Otherwise `portable/`, and the suite stays portable: no runtime adapter imports; the host comes from the shared factory in `portable/helpers/`, so the same suite can execute on any pool.

**Tier**: ask in order; the first yes names the test.

1. **Is the claim about the type surface?** ("this misuse cannot compile") - a type-level suite, `*-types.test.ts`, where passing `tsc` is the assertion. Negative cases are `@ts-expect-error` lines, positive cases use `Equal`/`Expect` helper types, and one trivial `it` anchors the file. These bite under `pnpm check`, not under the runner.
2. **Is the claim about one subject's own contract?** - `unit/`, under the rules below.
3. **Is the claim about a feature working as authored?** - `integration/in-process/`, unless the claim names the wire, the socket, or a foreign peer; then `integration/transport/`, which is always under a runtime root, since a transport claim is never portable.
4. **Does the feature span runtimes or backings?** - it needs a parity entry: one shared route set and scenario matrix, each runtime supplying only its connector, so every backing runs the same handlers and assertions. A deliberate divergence is encoded in the caps with the loud failure it produces; a silent divergence is a bug in the matrix.
5. **Is the claim against external truth?** (a specification, a live platform) - [conformance and probes](conformance-and-probes.md).

There is no artifact tier. Examining a value's shape at runtime is an ordinary assertion inside a unit or integration test of whatever produced it. An artifact test compares against a predetermined, committed artifact, such as a golden corpus, and earns a tier only when such a corpus exists.

## Unit

One subject's own contract, driven through its own API. The subject is the `src/lib` module the suite's path mirrors, and the unit is that module's owner as defined by its [file kind](../organization/file-kinds.md): a class module's unit is the class; an operations module's units are its exported functions.

**Classes** (class modules):

- One suite per class module, or, for a large class, a directory named for the class whose files split by behavior area; the mirror still names the subject. The class is real and driven only through its public API, whichever class it is, the host included. Exported symbol-keyed seams such as `UPGRADE_WS` are part of that API: they are the declared contracts internal drivers hold.
- Private methods and `#fields` are never tested directly. A private is either reachable through public behavior, and tested there, or it is dead. Wanting to test a private directly is a design signal with a standard answer: if it does not touch `this`, [structure](../code/structure.md) already makes it a module function, so it is extracted and tested as one; if it does, its state transitions are observable through the behavior that state serves.
- Trivial accessors get no tests.
- The subject's collaborators are real flare code. Only the edges are replaced ([testing](testing.md), principle 2): the adapter a host is handed, the platform socket a connection wraps, storage, the network, the clock. A replacement follows [doubles and idioms](doubles-and-idioms.md). Inputs are arranged through the subject's own API or made by their real producers.

**Module functions** (operations modules):

- Each exported function is tested directly: value in, value out, exact outputs and error messages pinned. Sociable with the functions it composes.
- Unexported helpers are never imported by a test; they are exercised through their consumer.

**Declarations**:

- Pure types are the type tier's business; they have no runtime to test.
- A runtime constant gets a unit test only when it pins an external contract, such as wire close codes; internal defaults do not.

**No static-type assertions in runtime tests.** A runtime test never asserts what the compiler already proved (`typeof x === "function"` on a value typed as a function); type claims belong in a `*-types.test.ts` suite. Asserting which runtime variant of a union or erased value materialized is behavioral and fine: `toBeInstanceOf(Promise)` on a `void | Promise<void>` return asserts the backpressure contract, not the type.

## Integration

A feature exercised across units through the public surface. The vehicle depends on the package: in core it is a real Flare app in test mode (real registration through the public authoring surface, real `host.build()`); in a pure package like lib it is composition of the public API, and no app is required. Either way, only public surface is consumed: no symbol-keyed seams, no internal imports. An assertion that needs an internal seam belongs in a unit test of that seam; if no public observation point exists for the behavior, that is a gap in the feature.

In core, two categories separated by folder:

- **`integration/in-process/`** - the `.test()` harness or the public white-box Durable Object helpers. No sockets. This is the default: faster, and nothing to flake.
- **`integration/transport/`** - a real server on an ephemeral port (`.run({ port: 0 })`, real TCP and WebSocket clients). Justified if and only if the code under test is the transport: the claim involves bytes on a wire, socket lifecycle (backpressure, teardown, draining in-flight connections), or a peer flare did not implement. A claim above the transport, such as routing, middleware, DI, or validation, uses the in-process harness; the port would add flake and wall-clock while exercising nothing the claim mentions.

Two standing rules:

- **Serialization rule**: every boundary where data is serialized or deserialized (wire frames, socket attachments, HTTP bodies, `flare.json`, config from the environment) has integration coverage in the category that exercises the real encoding.
- **Hermeticity rule**: automated integration touches localhost at most, never an external system.

## Cloudflare: white-box and real-binding

Durable Object tests come in two deliberate styles, chosen by what the fake cannot hold ([testing](testing.md), principle 3).

- **White-box** (default): `composeDurableInstance` drives the real per-instance container graph in-process with the fake Durable Object state and storage, no miniflare. Fast, and the raw Response is inspectable.
- **Real-binding**: a wrangler Durable Object binding through the fixture worker, for what the fakes cannot hold: SQL-backed storage, the platform's Durable Object base class, eviction, real bindings, and any platform limit the fake does not enforce. A suite that needs one of these says so in its header.
