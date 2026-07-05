# Choosing a test

Which test to write, and the tier rules that decide it. The suite layout is
[structure.md](structure.md); the writing mechanics are
[doubles-and-idioms.md](doubles-and-idioms.md); tests against external truth are
[conformance-and-probes.md](conformance-and-probes.md).

## The principle

A test verifies behavior through the widest interface that can observe it, at the tier that
interface defines. Build in vertical slices: one behavior's test, then its implementation, then
the next - never all tests first.

## Unit

Isolation around one subject. The subject is the `src/lib` module the suite's path mirrors, and
the unit is that module's OWNER as defined by its file kind (see the organization standards):
a class module's unit is the class; an operations module's units are its exported functions.
Flare unit tests are solitary toward behavioral collaborators and sociable toward pure values
and same-module composition.

**Classes** (class modules):

- One suite per class module - or, for a large class, a directory named for the class whose
  files split by behavior area (`unit/host/flare-host/*.test.ts`); the mirror still names the
  subject. The class is real and driven only through its public API -
  whichever class it is (`unit/host/**` constructs a `FlareHost` and calls `build()`; the host is
  the subject there). Exported symbol-keyed seams (`UPGRADE_WS`, `COMPILE_WS_ARC`) are part of the
  public API: they are the declared contracts internal drivers hold.
- `it()` names an observable behavior, never a method: "sends a keepalive ping on each interval",
  not "#onKeepAlive works". `describe` groups behaviors, not the method list.
- Private methods and `#fields` are never tested directly. A private is either reachable through
  public behavior (test it there) or it is dead. Wanting to test a private directly is a design
  signal with a standard answer: if it does not touch `this`, the organization rules already make
  it a module function - extract it and test it as one; if it does, its state transitions are
  observable through the behavior that state serves.
- Trivial accessors get no tests.
- Every behavioral collaborator of the subject - anything stateful, asynchronous, or I/O-touching
  that is not the subject - is a fake owned by the test: the adapter handed to a host, the socket
  handed to an engine, the host handed to an arc. Pure value dependencies (schema tokens, plain
  data) stay real. Inputs are arranged through the subject's own API or passed as value
  artifacts; a live non-subject collaborator behaving during the assertion means the test is not
  isolated.

**Module functions** (operations modules):

- Each exported function is tested directly: value in, value out, exact outputs and error
  messages pinned (the lib style). Sociable by default with the pure functions it composes;
  solitary only where a collaborator is behavioral.
- Unexported helpers are never imported by a test; they are exercised through their consumer.

**Declarations**:

- Pure types are the type tier's business (decision path step 1); they have no runtime to test.
- A runtime constant gets a unit test only when it pins an external contract (`WS_CLOSE` wire
  codes); internal defaults do not.

**No static-type assertions in runtime tests.** A runtime test never asserts what the compiler
already proved (`typeof x === "function"` on a value typed as a function); type claims belong in
a `*-types.test.ts` suite where passing `tsc` is the assertion. Asserting which runtime VARIANT
of a union or erased value materialized is behavioral and fine: `toBeInstanceOf(Promise)` on a
`void | Promise<void>` return asserts the backpressure contract, not the type.

## Integration

A feature exercised across units through the public surface. The vehicle depends on the package:
in core it is a real Flare app in test mode (real registration through the public authoring
surface, real `host.build()`); in a pure package like lib it is composition of the public API
(schema, primitives, and parser working together) - no app exists and none is required. Either
way, only public surface is consumed: no symbol-keyed seams, no internal imports. An assertion
that needs an internal seam belongs in a unit test of that seam; if no public observation point
exists for the behavior, surface that as a gap in the feature.

In core, two categories separated by folder:

- **`integration/in-process/`** - the `.test()` harness or the public white-box DO helpers
  on `@flare-ts/core/cloudflare`. No sockets. This is the default: faster, no flake
  surface.
- **`integration/transport/`** - a real server on an ephemeral port (`.run({ port: 0 })`, real
  TCP/WS clients). Justified if and only if the code under test IS the transport: the claim
  involves bytes on a wire, socket lifecycle (backpressure, teardown, draining in-flight
  connections), or a peer we did not implement. A claim above the transport - routing,
  middleware, DI, validation - uses the in-process harness; the port would add flake and
  wall-clock while exercising nothing the claim mentions.

Two standing rules:

- **Serialization rule**: every boundary where data is serialized or deserialized (wire frames,
  DO attachments, HTTP bodies, `flare.json`, config env) has integration coverage in the category
  that exercises the real encoding.
- **Hermeticity rule**: automated integration touches localhost at most, never an external
  system. External truth belongs to [conformance-and-probes.md](conformance-and-probes.md).

## The decision path

Two questions place every test: WHICH RUNTIME ROOT, then WHICH TIER.

**Root**: does the claim name a specific runtime's behavior (node streams and sockets, workerd
and Durable Objects)? Then that runtime's root, using its adapter and helpers. Otherwise
`portable/` - and the suite must stay portable: no runtime adapter imports; the host comes from
the shared factory in `portable/helpers/`, so the same suite can execute on any pool.

**Tier**: ask in order; the first yes names the test.

1. **Is the claim about the type surface?** ("this misuse cannot compile") - a type-level suite:
   `*-types.test.ts`, where passing `tsc` IS the assertion. Negative cases are `@ts-expect-error`
   lines, positive cases use `Equal`/`Expect` helper types, one trivial `it` anchors the file.
   These bite under `pnpm check`, not under the runner.
2. **Is the claim about one subject's own contract?** - `unit/`, under the rules above.
3. **Is the claim about a feature working as authored?** - `integration/in-process/`, unless the
   claim names the wire, the socket, or a foreign peer - then `integration/transport/` (which is
   always under a runtime root; a transport claim is never agnostic).
4. **Does the feature span runtimes or backings?** - it requires a parity entry: one shared route
   set and scenario matrix, each runtime supplying only its connector, so every backing runs
   literally the same handlers and assertions. A deliberate divergence is encoded in the caps
   with the loud failure it produces; a silent divergence is a bug in the matrix.
5. **Is the claim against external truth?** (a specification, a live platform) -
   [conformance-and-probes.md](conformance-and-probes.md).

There is no artifact tier. Examining a value's shape at runtime is an ordinary assertion inside a
unit or integration test of whatever produced it. "Artifact" testing means comparing against a
predetermined, committed artifact (a golden corpus); it earns a tier only if such a corpus exists.

## Cloudflare: white-box vs real-binding

Durable Object tests come in two deliberate styles; choose by what the fake cannot reach.

- **White-box** (default): `composeDurableInstance` drives the real per-instance container graph
  in-process with `makeFakeDurableState` / `makeFakeStorage`, no miniflare. Fast, and the raw
  Response is inspectable.
- **Real-binding**: a wrangler DO binding through the fixture worker, for what fakes cannot
  provide: SQL-backed storage (`makeFakeStorage` is KV-only), the native DO base class, eviction
  behavior, real bindings. A suite that needs one of these says so in its header.

## Pinning

A test pins a behavior against drift. If a behavior cannot be tested at any tier without
fabricating access to internals, flag it as not testable rather than writing a fake-driven
imitation of it. How a suite declares what it pins (headers, labels) is in
[doubles-and-idioms.md](doubles-and-idioms.md).
