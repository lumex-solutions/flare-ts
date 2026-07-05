---
name: flare-testing
description: Review or fix ONE flare test file or small test folder against the flare testing standards (runtime root, tier, unit isolation, doubles, idioms). Use when authoring tests (run before finishing), or when the user asks to review tests at a specific path. Not for repo-wide sweeps.
---

# flare-testing

Audit one test file (or one small folder of tests) against the testing standards, report findings
with line references, and apply fixes when asked.

## Input

A target path is required: one `*.test.ts` file, or a folder of tests. For a folder, collect the
test files under it; if that is more than ~20 files, stop and tell the user this skill is scoped
to a suite or subsystem, and ask them to narrow the target. Never expand scope beyond the target.

## Rules source

Read all four standards before auditing (paths from the repo root):

1. `standards/testing/structure.md`
2. `standards/testing/choosing-tests.md`
3. `standards/testing/doubles-and-idioms.md`
4. `standards/testing/conformance-and-probes.md`

The standards are the only rules. Do not import preferences from elsewhere.

## Procedure

For each target file, four passes:

1. **Placement** - is the file in the right runtime root and tier?
   - Root: a suite whose claim names a runtime's behavior belongs under that runtime's root; a
     suite under `portable/` (or in a package whose whole tree is portable) must import no runtime
     adapter - hosts come from the portable host factory. A runtime adapter import in a portable
     suite is a violation; a suite under a runtime root with no runtime-specific claim is a
     `decision` (it may be portable).
   - Tier: walk the decision path. A unit suite's path must mirror its subject's src module. An
     integration suite binding a real port with no wire/socket/foreign-peer claim is a violation
     (belongs in-process); an in-process suite opening sockets is a violation. Conformance/prober
     content inside the ordinary tiers is a violation.
2. **Unit rules** (unit suites only) - the subject is real and driven through its own API;
   every behavioral collaborator is a fake owned by the test; no private methods or `#fields`
   tested directly; no assertions restating a static type (asserting which runtime variant of a
   union materialized is behavioral and fine; type claims belong in a `*-types.test.ts` suite);
   no tests of trivial accessors; `it()` names behaviors, never methods.
3. **Integration rules** (integration suites only) - public surface only: no symbol-keyed seams,
   no internal value imports (type-only imports are tolerated); the vehicle matches the package
   (real app in test mode in core, public-API composition in lib); hermetic (localhost at most).
4. **Doubles and idioms** - fakes are minimal slices widened with a single cast, unimplemented
   members absent; published helpers over ad-hoc fakes; `vi.fn`/`vi.spyOn` observe boundaries,
   never stub internals; fake timers scoped and opt-in; no fixed-duration sleeps (reject-timeout
   guards around awaited events are fine); FLARE_MODE first-statement rule where import order
   matters; required suite headers on integration and cloudflare suites; behavior-sentence
   naming; labels ("pins", "regression", "control:") where they apply.

## Report

One findings table, ordered by file then line:

| Location       | Rule             | Severity  | Finding                                              |
| -------------- | ---------------- | --------- | ---------------------------------------------------- |
| `x.test.ts:12` | placement / tier | violation | Binds an ephemeral port but claims routing behavior. |

Severities: **violation** (breaks a stated rule), **missing** (something required is absent: a
suite header, a parity entry for a backing-spanning feature), **suggestion** (compliant but a
clearer seam, name, or published helper applies), **decision** (the standard defers to a developer
ruling - a borderline runtime claim, a borderline tier; surfaced, never auto-fixed). After the
table, one verdict line: file count, finding count by severity. Zero findings is reported plainly
as a pass.

## Fix mode

Apply fixes only when asked (or when you are the author finishing a suite). Constraints:

- Never weaken an assertion or delete a case to make a finding disappear; that is a `decision`
  for the developer.
- A move between roots or tiers updates every importer and must pass typecheck and the target
  pool's run before it counts as done.
- Never act on a `decision` finding without an explicit ruling.
- After fixing, re-run the audit passes on the touched files and report the remaining findings.
