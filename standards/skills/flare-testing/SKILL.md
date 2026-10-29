---
name: flare-testing
description: Review or fix ONE flare test file or small test folder against the flare testing standards (placement by runtime root and tier, tests shown to fail, real path and seams, replacements as strict as the real thing, behavior and suite shape). Use when finishing tests, or when the user asks to review tests at a specific path. Not for repo-wide sweeps.
---

# flare-testing

Audit one test file, or one small folder of tests, against the testing standards. Report findings with line references. Apply fixes when asked.

## Input

A target path: one `*.test.ts` file or a folder of tests. For a folder, collect the test files under it; more than about twenty means the target is too wide, so stop and ask for a narrower one. Never expand scope beyond the target.

## Rules source

Read, in this order, from the repository root:

1. `standards/testing/testing.md` (the principles)
2. `standards/testing/choosing-tests.md`
3. `standards/testing/doubles-and-idioms.md`
4. `standards/testing/structure.md`
5. `standards/testing/conformance-and-probes.md`, when the target is a conformance suite or a probe

The standards are the only rules. Do not import preferences from elsewhere.

## Procedure

Five passes per file, then the break check:

1. **Placement.** The file is in the right runtime root and tier. A suite under `portable/`, or in a package whose whole suite is portable, imports no runtime adapter; its hosts come from the portable host factory. A runtime adapter import in a portable suite is a violation; a suite under a runtime root with no runtime-specific claim is a `decision`. Walk the decision path: a unit suite's path mirrors its subject's src module; an integration suite binding a real port with no wire, socket, or foreign-peer claim is a violation; an in-process suite opening sockets is a violation; conformance or probe content inside the ordinary tiers is a violation.
2. **Fails.** Each expected value comes from the contract, not from the code under test or a helper it uses. A negative case fails for its own reason: a refusal that happens anyway, or a throw the code swallows, is a violation. A name that promises more than its assertions check is a violation. A case pinning a shape the code no longer writes is a violation.
3. **Real path and seams.** The subject is real and driven through its own API; its flare collaborators are real, and only the edges are replaced. A module mock, a stubbed internal collaborator, or a fake standing in for flare code that is not an edge is a violation. Input that crosses a seam, typed by hand where the producer could make it, is a violation; a kind of output the producer can emit that no consumer suite feeds is `missing`. An integration suite reaching a symbol-keyed seam or importing an internal value is a violation; type-only imports are tolerated.
4. **Replacements.** Each fake holds the rules of the thing it stands in for that the code depends on: its limits, refusals, error types, and codes. A fake that accepts everything, or throws a plain `Error` where the real thing throws its own type, is a violation. A rule the fake cannot hold, claimed by the suite anyway, is a violation; left unclaimed with no header saying so, it is `missing`. A fake is a minimal slice widened with a single cast, with unimplemented members absent; an ad-hoc fake where a published helper fits is a suggestion.
5. **Behavior and shape.** Each `it` is a behavior sentence and asserts something a caller can observe. A private reached, a static type restated at runtime, a trivial accessor tested, a fixed sleep, or a global fake timer is a violation. A trust-boundary suite missing a rejection path the design names is `missing`, as is a header an integration or Cloudflare suite requires. The `FLARE_MODE` first-statement rule where import order matters, section comments where they help, and labels where they apply are checked as suggestions.

**Break check.** Before the first break, record the content of each production file you will touch. For each case in scope, make one edit to the production code that breaks the behavior its name gives, run that case on its pool, then restore the file by undoing exactly that edit. Never restore with `git checkout`, `git stash`, or any command that discards other uncommitted work in the file. When done, confirm every production file matches what you recorded. A case that stays green under the break is a violation. Where no single edit breaks the behavior, say so in the finding instead of skipping it.

## Report

One table, ordered by file then line:

| Location        | Rule        | Severity  | Finding                                              |
| --------------- | ----------- | --------- | ---------------------------------------------------- |
| `x.test.ts:12`  | placement   | violation | Binds an ephemeral port but claims routing behavior. |
| `ws.test.ts:88` | break check | violation | Stays green with the close-code check removed.       |

Severities: **violation**, **missing**, **suggestion**, **decision** (the standard locates the call with the developer: whether a behavior is worth pinning, which platform rules a fake must hold, a borderline root or tier). After the table, one line: files audited, cases break-checked, findings by severity. Zero findings is reported as a pass.

## Fix mode

Only when asked, or when you are the author finishing tests. Never weaken an assertion or delete a case to make a finding disappear; report the behavior instead, as a `decision`. A new or rewritten case is run against broken code first and seen to fail. A move between roots or tiers updates every importer. Never act on a `decision` without an explicit ruling. After fixing, run the formatter, lint, the type checker, and the touched suites on their pools once, re-audit, and report what remains.
