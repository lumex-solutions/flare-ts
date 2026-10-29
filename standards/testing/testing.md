---
title: Testing
description: What a test proves, how it is shown to fail, what it may replace and how strictly, what it observes, and where and when the suites and gates run.
---

# Testing

What a test is, how it is written, and how the suites run. The detail is in [choosing-tests.md](choosing-tests.md), [doubles-and-idioms.md](doubles-and-idioms.md), [structure.md](structure.md), and [conformance-and-probes.md](conformance-and-probes.md).

## Principles

1. **A test is written to fail.** It is written from the contract it pins, and its expected value comes from that contract, never from the code's output. Before it is trusted it is seen to fail for the reason its name gives: written ahead of the code, or with the code under it broken. A test that has never failed proves nothing, since a test that agrees with whatever the code does cannot disagree with it. When a contract changes, its tests are worked out again from the new contract, not edited until they pass.

2. **Drive the real path, on the real runtime; replace only at the edges.** A test builds a real app through the public authoring surface, or drives a real module through its own API, on the runtime whose behavior it claims. The edges are the platform and what lies beyond it: the objects a runtime supplies, such as a socket, storage, or a Durable Object's state, the adapter that stands between flare and its runtime, the network, and the clock. Everything inside them is real. What crosses a seam in a test is what the producer on the other side really makes, got by calling that producer, never a hand-written copy of its shape. Module mocking is never the strategy; a test that must mock an internal to reach its assertion is testing at the wrong level.

3. **A replacement is no more forgiving than what it replaces.** A fake for a platform object holds the code to the rules of the thing it stands in for that the code depends on: its limits, its refusals, and the errors it answers with. A fake that accepts everything turns the test into a statement of our own belief about the platform. A rule the fake cannot hold is never claimed: the suite says it does not judge it, and a real binding or a probe checks it. This holds twice over for the testing helpers flare publishes, since every app's suites inherit their leniency.

4. **A test pins a behavior through the widest interface that can observe it.** The assertion is something a caller can see, named as the behavior it pins, in a sentence: "rejects a close code outside the sendable range". No private is reached. A behavior that cannot be observed without fabricating access is a design finding, not a test with fabricated access.

5. **Every push runs hermetic, on every runtime; external truth runs by hand; the gates run once, at the end.** The suites that run on every push touch localhost at most and run on every runtime's pool, so a divergence between backings surfaces where it starts. Suites against external truth, a published specification or the live platform, run deliberately and commit their evidence. No automated test calls an outside service. Format, types, lint, and the suites a change touches run in one pass after the work is done, the full run for a change to a shared piece. A gate that fails is fixed and run again; a gate is never skipped.

## Where judgment sits

What to test is a domain decision made per piece of work by the developer, on what can actually go wrong, and checked in review. The rules say how; they do not say which behaviors matter, and no document can. Which rules of a platform a fake must hold is the same kind of call: the ones the code depends on, decided by the developer.
