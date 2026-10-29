---
title: Doubles and idioms
description: How a test is written once its tier is chosen: showing it fails, what crosses a seam, how a replacement is built, timing, environment, and suite shape.
---

# Doubles and idioms

The detail behind principles 1 to 4 of [testing](testing.md): how a test is written once its tier is chosen.

## Showing a test fails (principle 1)

- Work proceeds in vertical slices: one behavior's test, then its implementation, then the next, never all tests first.
- A new case is run once against code that is wrong in the way the case names: before the fix for a bug, before the feature for new work, or with the line under it broken. It fails, then the code is put right and it passes.
- A negative case fails for its own reason. A refusal that would happen anyway, or a throw the code swallows, makes the case pass whatever the guard it names does.
- A case's name says only what its assertions check. A name that promises more than the assertion sees is rewritten, or the assertion is widened.
- Review breaks the code under each new case. A case that stays green is rewritten or deleted.

## Seams (principle 2)

- A consumer's suite is fed each kind of output its producer makes, made by the producer: a frame built by the real encoder, an attachment written by the real writer. A kind the producer can emit that no consumer suite feeds is a missing case.
- A recorded frame, a stored value, or a message replayed in a test is one the code writes today, made by running that code, never typed from memory of its shape.

## Replacements (principle 3)

- A fake implements the surface the code consumes and nothing more, widened with a single `as unknown as PlatformType` cast that carries its pairing note. A member it does not implement is absent on purpose: touching it fails at the call site instead of passing quietly.
- A fake refuses what the real thing refuses, with the error type and code the real thing throws, at the limits the real thing has. A fake that cannot hold a rule leaves it to a real binding or a probe, and the suite's header says so.
- The published helpers, such as `makeFakeDurableState` and `makeFakeStorage`, are preferred over ad-hoc fakes, and they are held to this section first, since every app's suites use them.
- When a fake must let the real logic run and only stop the I/O, it subclasses the real class and overrides the I/O methods, so delivery is synchronous and inspectable: a `Duplex` subclass with captured writes, settable backpressure, and direct `data`, `close`, and `error` emission.
- `vi.fn` and `vi.spyOn` observe a boundary: a dispose call, a transport write, a line logged. They never stub a collaborator.
- Secrets are generated in-test, never committed, and a signed value is signed over the same bytes the verifier checks, so the test proves the real signature path.

## Time and waiting

- Fake timers are opt-in per suite, never global, and scoped to exactly the timer functions the suite needs. Suites default their timing options off (`keepAliveIntervalMs: 0`) so a live interval cannot leak under real timers.
- Microtask and I/O draining uses the flush idiom: `const flush = () => new Promise<void>((r) => setImmediate(r));`
- No fixed sleeps. Wait on the signal the code exposes: a promise the handler resolves, an emitted event, an entered flag. A reject-after-N timeout guard wrapped around an awaited event is fine; it converts a hang into a precise failure.

## Environment (principle 2)

- The environment every suite runs under is set in one place, the pool's configuration, and the framework's own configuration parse runs. The node pool injects `FLARE_MODE=test` there; a suite where import order matters, because the adapter reads `process.env` at import, sets it as the file's first statement, with a comment saying why it precedes the imports.
- Cloudflare test adapters read `adapter.env.FLARE_MODE`, never `process.env`.

## Suite shape (principle 4)

- `describe` names the property under test, not the class; `it` is a full behavior sentence, phrased as the specification the test pins: "two Durable Object instances with distinct ids each get their own scoped service container".
- Integration and Cloudflare suites open with a header comment stating what the file pins, why it drives that seam, and what it does not judge, such as a platform limit the fake does not hold. A unit or lib suite may omit the header when the filename and `describe` already say it.
- Cases group under section comments, Primary Behavior, Edge Cases, Failure Modes, and Cross-Feature Interactions, where the grouping helps a reader.
- A suite for a trust boundary, such as a handshake check, a signed cookie, or a schema guard, has a case for every rejection path and every attack shape the design names. It is never trimmed to the interesting ones.
- Labels, where they apply: "pins" for behavior locked against drift, "regression" for guards on shipped fixes, "white-box" and "real-binding" for the two Durable Object styles, "control:" for the non-failing counterpart assertion.
- `lib` suites are terse pure-function tests: direct value and throw assertions, exact error strings pinned, no host machinery.
