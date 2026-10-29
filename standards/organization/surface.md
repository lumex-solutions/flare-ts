---
title: API surface
description: What a consumer of a flare package sees when they import, hover, extend, or read the docs: concepts shipped as what they are, every public noun earned, types inferred from values, siblings that spell their difference, and two authoring forms on one core.
---

# API surface

The shape of public artifacts: what a consumer of a flare package sees when they import, hover, extend, or read the docs. Organization says where code lives; this says what the exported thing is.

## Principles

1. **A public concept ships as the declaration kind it is.** A class as a `class` declaration, a factory as a named `function`, a vocabulary constant as a plain `const`, and a developer-held object the surface returns as an exported class. An IDE hover on the imported name shows the concept the docs describe, go-to-definition lands on it, and a subclass reads like one. If a type cannot be expressed without bending the export, the type is the defect, not the export.

2. **Every public noun is earned.** A concept enters the surface only when a developer cannot do the job without naming it. Near-synonyms are deleted, not accumulated. When explaining concept N requires introducing concept N+1, N+1 is questioned first. Each noun is one more thing every developer learns before they can read someone else's app.

3. **Developers write values; the types follow.** A public factory infers its result's types end to end from the values it is given, so a developer never writes a type annotation to make a result usable. A factory that needs a manual annotation has pushed its own type work onto every caller.

4. **Siblings spell their difference.** When two public exports share a noun and differ in behavior, the names carry the difference: a reader comparing the two signatures can state what changes without opening either body. The hover test applies to the pair, not each name alone. Two near-twin names with silently opposite contracts are a violation even when each is documented, since the documentation is read after the wrong one is chosen.

5. **Two forms of one surface share one core.** When a surface offers two authoring forms, such as a function handler and a class controller, or two backings, such as a resident and a hibernating socket, both feed one shared core and speak one vocabulary. Divergence between the forms is a bug even when each works alone, because a developer who switches forms expects the same app.

## Export shape (principle 1)

- A cast at an export site (`export const X = Y as unknown as Z`) is a violation: it breaks TypeDoc rendering, go-to-definition, and subclass comprehension.
- A developer-held object returned by the surface is an exported class, exported type-only from the package index when callers must not construct it.
- **The sanctioned exception: runtime-stamped construction.** When a constructor installs members at runtime whose types depend on its arguments, such as extension members an adapter stamps on, a class declaration cannot type its own construction result. The pattern is a merged const and type pair: the const casts the class to a construct-signature interface, and the type alias mirrors the construct signature's full return, including every generic the constructor infers. All four guardrails are required: the cast is type-only and the value is the class, so `instanceof` holds; the cast carries a pairing note; the construct-signature interface's doc points readers at the instance type; a types test pins that the stamped members compile against both the construction and the alias.

## Inference (principle 3)

- The house shape is the extract-func pattern: `const` type parameters plus inference from the descriptor argument (`socketContract`, `flareErrorCodes`, `flareConfig`).
- Explicit type parameters are used where the descriptor cannot carry the information. A discriminated union is the case: it cannot be inferred from its branches, so its overload takes the union explicitly (`schema<Pet, "union">("kind", ...)`).
- Exactly two marker idioms exist. Each is picked by its job, the jobs are never mixed, and no third is invented:
  - A symbol brand whose value carries the kind, for discriminating kinds (`CONTRACT_BRAND`, `SCHEMA_BRAND`).
  - An optional phantom member `_type?: T`, for carrying an inferred type (`ConfigToken`, `ErrorSchema`).
- A marker exists only to make a type checkable or inferable. Symbol-keyed hidden state is a different mechanism: real runtime data stored behind a symbol key to keep it off the public surface (`SCHEMA_DESCRIPTOR`, `UPGRADE_WS`). Where its symbol lives is [declarations](declarations.md).

## Runtime variants (principle 4)

- A sync and an async class pair for one concept, such as `CfLogger` and `Logger`, is a deliberate type-level fence: the sync base narrows lifecycle hooks so a variant cannot declare hooks its runtime would mishandle. The pair is never merged, and neither inherits from the other's family: TypeScript's void-return assignability lets the wrong inheritance typecheck while destroying the fence, so an async hook added to a shared parent is silently dropped at runtime. Shared logic goes behind a shared operations module or a parameterized function, both classes stay thin on their own bases, and the pair carries an anti-unification note.

## Where judgment sits

Whether a noun has earned its place is decided in a design conversation, before it ships; once public, removing it is a breaking change. Whether two forms have diverged or only look different is checked by running the same scenario through both.
