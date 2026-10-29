---
title: Organization
description: Where code lives and what it is called: one kind per file, folders as subsystems, declarations placed by kind, names reconciled against their family, and dependencies that point one way and are handed in.
---

# Organization

Where code lives, what it is named, and how one module reaches another. The detail for each principle is its own document: [file-kinds.md](file-kinds.md), [subsystems.md](subsystems.md), [declarations.md](declarations.md), and [naming.md](naming.md).

## Principles

1. **Every file is exactly one kind, declared by what it exports.** A class module, an operations module, or a declarations module, never two at once. A reader knows from the exports what the file is for and what may be added to it, and a file that mixes kinds has already become two concerns sharing a name.

2. **A folder is a subsystem, and code lives with the data it operates on.** A folder exists for one cohesive concern of two or more modules, never for a kind of file. An operations module sits beside the producer and the declarations of the data it works on, and its callers import across the boundary, so everything that changes when the data changes is in one place.

3. **A declaration lives where its kind sends it.** A type that makes one module's own signatures nameable lives beside that module; vocabulary other modules consume lives in a declarations module, at the lowest rung of the ladder that fits. The test is mechanical, signature or vocabulary, so two people placing the same type put it in the same file.

4. **A name is reconciled against its nearest family, and one word has one meaning.** A new name is checked against the existing names of the same kind before it is invented, and consistency across siblings beats local preference. A word means one thing across the codebase; a second meaning takes a qualifier or a different word. An interface carries the `I*` prefix that marks the contract side of a seam; no `Impl` suffix, no folder name repeated in a file name. Sibling names spell their difference: two things that differ in one property differ in one word.

5. **Dependencies point one way, and they are handed in.** `lib` imports no other package of this repository, and core imports `lib`. Portable code imports no runtime module, and one runtime's module imports no other runtime's; lint holds these arrows. Within them, a collaborator arrives as a parameter or through the container, never through a global, an ambient context, or a mutable module-level object, so a reader sees what a module depends on from its signatures.

## Where judgment sits

Whether two concerns are one subsystem or two, and whether a type on the line between signature and vocabulary is one or the other, are the developer's calls, made in review. Whether a shared piece has reached its second consumer is a fact, checked by reading the consumers, not a forecast.
