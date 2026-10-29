---
title: Comments
description: What a comment is for, and the three places one lives: the file header, the symbol doc, and the inline note.
---

# Comments

What is written about the code, and where. The detail for each place is its own document: [file-headers.md](file-headers.md), [jsdoc.md](jsdoc.md), and [inline-comments.md](inline-comments.md).

## Principles

1. **A comment says what the code cannot.** The why, the constraint, the invariant, the rejected alternative, the platform fact the next reader would otherwise have to rediscover. A comment that restates the next line is deleted; a comment that is wrong is worse than none, because the next developer trusts it.

2. **Every file opens with a signpost, never a map.** One sentence to a short paragraph saying what the file is and where it sits, before the imports. Detail goes down onto the symbol that owns it, where an edit is forced to keep it true; a header nobody edits drifts.

3. **Every export says what it is.** A verb-led sentence for a function, a noun phrase for a class or a type, one line where one line will do, a body only for what a caller must know and cannot see in the signature. Equivalent symbols use equivalent phrasing, so a reader can tell like from unlike. Private symbols need a doc only when their name does not say it.

4. **Plain words, present tense, written for someone mid-task.** No history, no plan, no session, no coined phrase that needs the author to explain it. No em dashes, no dividers, no filler openers. If a sentence needs a second reading, it is rewritten or removed.

5. **Some constructs are only legal with a note beside them.** A cast or an `unknown` seam, a promise deliberately dropped, a lint suppression, a security-sensitive constant or ordering, and a module-level variable that changes after load each carry a plain note naming the reason. The note is part of the construct: without it the construct is a finding.

## Where judgment sits

Whether a header has outgrown one paragraph because the file is genuinely that complex is a developer's call, made in review, never by a tool. Whether a why-comment is needed is decided by asking what a competent reader who has never seen this repository would have to look up.
