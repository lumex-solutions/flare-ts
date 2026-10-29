---
name: flare-comments
description: Review or fix the comments in ONE flare file or small folder against the flare comments standards (file header, symbol docs, inline notes). Use when finishing a flare module, or when the user asks to review or fix comments at a specific path. Not for repo-wide sweeps.
---

# flare-comments

Audit one file, or one small folder, against the comments standards. Report findings with line references. Apply fixes when asked.

## Input

A target path: one `.ts` file or a folder. For a folder, collect the `.ts` files under it; more than about twenty means the target is too wide, so stop and ask for a narrower one. Never expand scope beyond the target.

## Rules source

Read, in this order, from the repository root:

1. `standards/comments/comments.md` (the principles)
2. `standards/comments/file-headers.md`
3. `standards/comments/jsdoc.md`
4. `standards/comments/inline-comments.md`

The standards are the only rules. Do not import preferences from elsewhere.

## Procedure

Three passes per file:

1. **Header.** Present on every file, first thing before imports; absence is `missing`, with no trivial-file exception. One sentence to a short paragraph. A header that maps the system, narrates history, lists exports, or walks through the implementation is a violation. A header that is long because the file is genuinely complex is a `decision` for the developer, reported with what could move down to symbol docs, and never shrunk without an explicit instruction.
2. **Symbol docs.** Every export has one, checked against the rules for its kind: summary grammar (verb-led for functions, noun phrase otherwise, no "This", "A", or "An" openers, no restating the signature), a body only for what a caller cannot see, tags in the documented format (`@param name - Description.`), the `{@link}` rules, and the verb vocabulary. History, plan language, and editorial filler are violations. Non-exported symbols need a doc only when their name does not say it.
3. **Inline notes.** Every note says what the next line cannot; restatements are violations. A cast, an `as unknown as`, or a declared `unknown` without a note naming its seam is `missing`, as is a dropped promise, a lint suppression, a security-sensitive constant or ordering, or a module-level variable that changes after load, each without its note; an ordinary declaration with a proper type needs none. Em dashes, dividers, filler openers, coined phrases, commented-out code, and plan-relative language are violations. A seam that calls for a house idiom and lacks it is a suggestion.

## Report

One table, ordered by file then line:

| Location     | Rule       | Severity  | Finding                     |
| ------------ | ---------- | --------- | --------------------------- |
| `path.ts:42` | symbol doc | violation | Summary starts with "This". |

Severities: **violation** (breaks a stated rule), **missing** (a required header, doc, or note is absent), **suggestion** (compliant, but a house idiom or plainer wording applies), **decision** (the standard defers to the developer, such as an over-length header on a genuinely complex file). After the table, one line: files audited, findings by severity. Zero findings is reported as a pass.

## Fix mode

Only when asked, or when you are the author finishing a module. Edit comments only; never change behavior. Never invent a rationale: when a why-comment or a doc body needs knowledge you do not have, such as why a constraint exists or what a magic value means, report it as **needs-author**. Everything you write must pass this skill. After fixing, run the formatter and lint on the touched files, re-audit them, and report what remains.
