# Test doubles and idioms

How a test is written once its tier is chosen: the double policy, timing, environment, and suite
shape. Tier rules are in [choosing-tests.md](choosing-tests.md).

## Doubles

Drive the real path whenever one exists. Fakes exist only where the tier rules call for one (a
behavioral collaborator in a unit test, a platform boundary anywhere), and they follow one shape:

- A fake implements only the slice the code under test consumes, and is widened with a single
  `as unknown as PlatformType` cast. Unimplemented members are absent on purpose: touching one
  fails loudly at the call site instead of silently succeeding.
- Prefer the published helpers over ad-hoc fakes: `makeFakeDurableState`, `makeFakeStorage`
  (KV-only; SQL needs a real binding), the Cloudflare test adapters in
  `tests/cloudflare/helpers/`.
- When byte-level control is needed, subclass the platform class and override its IO surface so
  delivery is synchronous and inspectable (`TestDuplex extends Duplex` in the WS engine suite:
  captured writes, settable backpressure, direct `data`/`close`/`error` emission).
- `vi.fn` / `vi.spyOn` observe a boundary (a dispose call, a transport write); they do not stub
  internal collaborators. A test that must mock an internal to reach its assertion is at the
  wrong tier.

## Timers and waiting

- Fake timers are opt-in per suite, never global. Suites default their timing options off
  (`keepAliveIntervalMs: 0`, ...) so a live interval cannot leak under real timers; the dedicated
  timer sub-suite opts in with `vi.useFakeTimers()` scoped to exactly the timer functions it
  needs.
- Microtask/IO draining uses the flush idiom:
  `const flush = () => new Promise<void>((r) => setImmediate(r));`
- Never wait on a fixed-duration sleep. Wait on the signal the code exposes: a promise the handler
  resolves, an emitted event, an entered-flag. A reject-after-N timeout guard wrapped around an
  awaited event is fine; it converts a hang into a precise failure instead of a wall-clock guess.

## Environment

- The node pool injects `FLARE_MODE=test` via config. A suite where import order matters (the
  adapter reads `process.env` at import) sets it as the file's first statement, with a comment
  saying why it precedes the imports.
- Cloudflare test adapters read `adapter.env.FLARE_MODE`, never `process.env`.

## Suite shape

- `it()` descriptions are full behavior sentences, phrased as the specification the test pins:
  "two DO instances with distinct ids each get their OWN scoped service container". `describe`
  names the property under test, not the class.
- Integration suites open with a header comment stating what the file pins and why it drives that
  seam. A unit or lib suite may omit the header when the filename and `describe` already say it.
- Behavioral suites group cases under section comments: Primary Behavior, Edge Cases, Failure
  Modes, Cross-Feature Interactions.
- Labels, where they apply: "pins" for behavior locked against drift, "regression" for guards on
  shipped fixes, "white-box" / "real-binding" for the two DO styles, "control:" for the
  non-failing counterpart assertion.
- `lib` suites are terse pure-function tests: direct value and throw assertions, exact error
  strings pinned, no host machinery.
