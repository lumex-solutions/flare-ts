---
name: flare-organization
description: Review ONE flare file or small folder against the flare design and organization standards (reason for existing; state, lifetime, and frequency; seams and wiring; file kinds and placement; naming; public surface). Use when finishing a flare module, or when the user asks to review the structure of a specific path. Not for repo-wide sweeps.
---

# flare-organization

Audit one file, or one small folder, against the design and organization standards. Report findings with line references. Apply fixes when asked.

## Input

A target path: one `.ts` file or a folder. For a folder, collect the `.ts` files under it; more than about twenty means the target is too wide, so stop and ask for a narrower one. Never expand scope beyond the target.

## Rules source

Read, in this order, from the repository root:

1. `standards/code/fundamentals.md` and `standards/code/structure.md`
2. `standards/organization/organization.md`, then its detail: `file-kinds.md`, `subsystems.md`, `declarations.md`, `naming.md`
3. `standards/organization/surface.md`, when the target exports public surface

The standards are the only rules. Do not import preferences from elsewhere.

## Procedure

Five passes per file, and a folder pass when the target is a folder:

1. **Reason.** For each exported construct, state in one sentence what it is for. A construct whose sentence is about a future that has not arrived, or that rests on an unchecked claim about a runtime or a platform, is a finding.
2. **Shape, lifetime, and frequency.** A class without state is a violation: it should be a function. A method that never touches `this`, or a `static` that is not a construction-adjacent factory, is a violation. A singleton without process-long state, a scoped service that holds process-long state, or a class that caches a value derived from configuration is a violation. Work on the per-request path that could run at build or once per isolate is a violation; per-request work added without a stated measurement is `missing`.
3. **Seams and wiring.** An interface or abstract class with one production implementation and no boundary that forbids the import is a violation; test fakes do not count as implementations. A collaborator reached through a global, an ambient context, or a mutable module-level object is a violation. An import against the package or runtime arrows is a violation. A constructor taking a bag of collaborators, or a function taking a whole object it reads two fields of, is a suggestion.
4. **File kind and placement.** Classify the file from its exports: mixed kinds are violations, as are a filename that breaks its kind's rule, in-file ordering out of order, and an import of another file's subordinate helper. Each exported declaration is checked against its kind's placement: signature or vocabulary for types, consumer-side home for interfaces, domain home for constants, key-owner home for symbols. A symbol exported only for a test is a finding. A borderline signature-or-vocabulary call is a `decision`.
5. **Naming and surface.** Names are checked against their nearest family and the audience tiers: an interface without its `I*` prefix, an implementation named for its interface instead of its job, an `Impl` or keyword suffix, a repeated folder name, or a word used with a second meaning is a violation. When a name looks off, cite the family it should reconcile against. For public exports: a cast at an export site outside the sanctioned exception, a factory whose result needs a manual annotation, a near-twin pair whose names hide a contract difference, or two authoring forms that diverge is a violation; a public noun whose need is unclear is a `decision`.

Folder pass: the folder is one subsystem, and nothing in it belongs to another. A file prefixed with the folder's name, or an operations module living with its callers instead of its data, is a violation. A layer-root `types/` whose contents all belong to one subsystem, or a concern that has grown a second module without earning a folder, is a `decision`.

## Report

One table, ordered by file then line:

| Location     | Rule          | Severity  | Finding                                         |
| ------------ | ------------- | --------- | ----------------------------------------------- |
| `path.ts:12` | design / seam | violation | Interface with one implementation, no boundary. |

Severities: **violation** (breaks a stated rule), **missing** (something the rules require is absent), **suggestion** (compliant, but a clearer placement, shape, or name applies), **decision** (the standard locates the call with the developer: a borderline signature-or-vocabulary call, a subsystem boundary, a lifetime that is a product question, whether a noun has earned its place). After the table, one line: files audited, findings by severity. Zero findings is reported as a pass.

## Fix mode

Only when asked, or when you are the author finishing a module. Placement and naming fixes are applied: moves, splits, renames, and re-exports, each updating every importer in the same pass. A change of shape, lifetime, seam, or public surface is proposed with its reason and applied only on the developer's yes, since each is a design change. Never act on a `decision` without an explicit ruling, and never change runtime behavior. After fixing, run the formatter, lint, and the type checker on the touched files, re-audit, and report what remains.
