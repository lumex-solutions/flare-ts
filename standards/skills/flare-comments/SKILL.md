---
name: flare-comments
description: Review or fix the comments in ONE flare file or small folder against the flare comment standards (file header, JSDoc, inline). Use when authoring a flare module (run before finishing), or when the user asks to review/fix comments on a specific path. Not for repo-wide sweeps.
---

# flare-comments

Audit one file (or one small folder) against the three comment standards, report findings with
line references, and apply fixes when asked.

## Input

A target path is required: one `.ts` file, or a folder. For a folder, collect the `.ts` files
under it; if that is more than ~20 files, stop and tell the user this skill is scoped to a single
module or subsystem, and ask them to narrow the target. Never expand scope beyond the target.

## Rules source

Read all three standards before auditing (paths from the repo root):

1. `standards/style/comments/file-headers.md`
2. `standards/style/comments/jsdoc.md`
3. `standards/style/comments/inline-comments.md`

The standards are the only rules. Do not import preferences from elsewhere.

## Procedure

For each target file, three passes:

1. **File header** - present on EVERY file, first thing before imports (absence is a `missing`
   finding, no "trivial file" exception). Size: one sentence to one short paragraph. An
   over-length header is reported as `decision`, never `violation`: the standard reserves a
   developer-only exception for genuinely complex files, so the agent surfaces it (noting what
   could push down to symbol JSDoc) and the developer rules. Fix mode never shrinks a header
   without an explicit instruction. Content bans stay hard findings: history/plan-relative
   language, export inventories, implementation walkthroughs.
2. **Symbol JSDoc** - every exported symbol, checked against the rules for ITS kind (summary
   grammar, body rules, tag formats including `@param name - Description.`, `{@link}` rules,
   verb vocabulary, the prohibited-patterns list). Non-exported symbols need JSDoc only when
   non-obvious.
3. **Inline comments** - the hard bans (em dashes, dividers, filler preambles, redundant
   obviousness, commented-out code, plan-relative language); required pairing notes present on
   type-system overrides (`as` / `as unknown as` casts, declared `unknown` seams - NOT ordinary
   declarations using a proper type), deliberate fire-and-forget, lint suppressions; house idioms
   used where a seam calls for one.

## Report

One findings table, ordered by file then line:

| Location     | Rule                 | Severity  | Finding                     |
| ------------ | -------------------- | --------- | --------------------------- |
| `path.ts:42` | jsdoc / summary line | violation | Summary starts with "This". |

Severities: **violation** (breaks a stated rule), **missing** (required comment absent: header,
pairing note, contract `@throws`), **suggestion** (compliant but a house idiom or clearer phrasing
applies), **decision** (the standard defers to a developer ruling - e.g. an over-length header on
a genuinely complex file; surfaced, never auto-fixed). After the table, one verdict line: file
count, finding count by severity. Zero findings is reported plainly as a pass.

## Fix mode

Apply fixes only when asked (or when you are the author finishing a module). Constraints:

- Edit comments only; never change code behavior.
- Never fabricate rationale. If a why-comment or JSDoc body requires knowledge you do not have
  (why a constraint exists, what a magic value means), report it as **needs-author** instead of
  inventing prose.
- Everything you write must itself pass this skill: no em dashes, spec-form tags, verb-led
  summaries.
- After fixing, re-run the audit passes on the touched files and report the remaining findings.
