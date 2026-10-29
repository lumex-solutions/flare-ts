---
title: What a standard is
description: What a document under standards/ may contain, what it may never contain, and the shape every one of them takes.
---

# What a standard is

The documents under `standards/` are decision procedures: rules a developer or an AI system applies to the code in front of them. This document governs the documents themselves. Why each section is capped at a few principles is [power-of-few.md](power-of-few.md).

## Principles

1. **A standard survives the rename test.** Every sentence must still be true if every file in the repository were renamed tomorrow. A sentence that names the current tree, counts the current modules, or describes what exists today is a cache of the codebase with no invalidation, and it lies within weeks.

2. **A standard states the rule, never the history.** Only the present: what is true now, not how it got here and not what it might become. No reference to a conversation, a session, a plan, a task number, a branch, or a former version of the document. Version control owns the past. If the reasoning matters, it is written as rationale that stands on its own. An open question is marked open in place, or left out.

3. **Principles first, and everything traces to one.** Each section opens with its 3 to 5 principles. Rules, examples, tool choices, and decision paths follow, and each must trace back to a principle. Detail that traces to nothing is a sixth principle coming in the side door.

4. **Written to be followed, mid-task.** Plain words, short sentences, the fewest of both that still say the thing. Prose earns its place by telling the reader something the code cannot show: the why, the constraint, the boundary. No em dashes, no decorative dividers, no arrow chains, no filler openers such as "note that" or "simply".

5. **Judgment is located, never omitted.** Where a call cannot be made mechanical, the document says so and names who decides. A rule that pretends to cover a judgment call teaches people to stop thinking exactly where thinking is needed.

## What a document may contain

- **Decision procedures.** "A class exists for state." "Portable code never imports a runtime module." Rules that classify whatever code they meet.
- **Invariants and boundaries.** Dependency arrows, fixed homes, the things that stay true until a design conversation changes them.
- **Illustrative examples.** Named classes, files, and functions used to show a rule. An example is a hypothetical: it need not exist in the tree, and no reader may conclude from a standard that a file exists.
- **Shapes drawn with placeholders.** A folder shape whose names are placeholders, such as `<subsystem>/` or `<runtime>/`, is a rule, not an inventory.

## What a document may never contain

- **Inventories.** No reference layouts of the current tree, no list of the suites or modules that exist, no count of them. The tree is one `ls` away.
- **Real files cited as fact.** "X lives in Y" is legal only when it is the rule, never when it describes today's arrangement.
- **Change narration.** No "recently", "now", "after the migration", "replaces". A standard describes the timeless rule or stays silent.

## The shape of a document

1. Frontmatter: a `title` and a one-line `description` saying what the document governs, so an index or an AI system can place it without opening it. Indexes such as the standards README skip it.
2. Scope: the first prose says what the document governs, and nothing else. The index is where documents are found, so a document does not list its neighbours. A rule lives in one place; where a rule depends on another document's, it links to that rule where it uses it.
3. The principles, numbered, each with its rationale in the same paragraph. A detail document under a section's principles names the principles it serves instead of carrying its own.
4. Detail: rules and decision paths under headings, each traceable to a principle.
5. Examples where a rule can be shown. A short correct and wrong pair sits at the rule. A longer walk-through gets its own examples document, linked from the rule, so the principles stay small.
6. Where judgment sits: the calls the document cannot make mechanical, and who makes them.

## How a standard changes

A standard changes when a design conversation changes the law: a new invariant, a new decision procedure, a boundary redrawn. It never changes to trail an implementation. If landing a change requires editing a standard to stay accurate, either the change breaks the law, which is a conversation to have first, or the standard contained inventory, which is deleted.
