---
title: The power of few
description: Every section is governed by 3 to 5 principles, and why that cap exists.
---

# The power of few

Every section of these standards is governed by a small fixed number of principles: 3 to 5. Not "roughly a handful", not "as many as it needs". If a section wants a sixth principle, one of the existing five has to be merged, generalized, or cut.

## Why

The idea comes from Gerard Holzmann's "The Power of Ten" (NASA/JPL). His observation: most coding guidelines run past a hundred rules, each new document longer than the last, many rules born from personal preference or one bad day years ago. The result is that the guidelines have little effect on what developers actually do. Nobody can follow a rulebook they cannot remember.

His answer for safety-critical code was ten strict rules, small enough to hold in your head, each carrying its own rationale. These standards do not need to be that strict, but the reasoning holds at any scale:

- A principle only works if a developer can hold it in mind while working. 3 to 5 fits in a head; 20 fits in a document nobody opens.
- The cap forces quality. When there are only five slots, a principle has to earn one, and earning one means it comes with a rationale, not a preference.
- The cap forces generality. Rules that exist to prevent one specific past mistake do not survive the squeeze; the principle that covers a whole class of mistakes does.

## What the cap covers

The cap is on principles: the statements a section derives everything else from. A section may still carry supporting detail below its principles (tool choices, examples, decision paths), but all of it must trace back to one of the 3 to 5. Detail that traces back to nothing is the sixth principle sneaking in the side door.
