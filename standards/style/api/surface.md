# API surface

Rules for the shape of public artifacts: what a consumer of a flare package sees when they
import, hover, extend, or read the docs. Organization rules say where code lives; these say
what the exported thing IS.

## Export-shape fidelity

A public concept ships as the declaration kind it is: a class as a `class` declaration, a
factory as a named `function`, a vocabulary constant as a plain `const`. A cast at an export
site (`export const X = Y as unknown as Z`) is a violation: it breaks TypeDoc rendering,
go-to-definition, and subclass comprehension. If a type cannot be expressed without an
export-site cast, the type is the defect, not the export.

Test: does an IDE hover on the imported name show the concept the docs describe?

Sanctioned exception - runtime-stamped constructor typing: when a constructor genuinely
installs members at runtime whose types depend on its arguments (adapter-stamped extensions,
a `const`-inferred extensions tuple), a class declaration cannot type its own construction
result. The pattern is a merged const+type pair: the const casts the class to a
construct-signature interface, the type alias mirrors the construct signature's full return
(including every generic the constructor infers). All four guardrails are required: the cast
is type-only and the value IS the class (instanceof intact); the cast carries a pairing note;
the construct-signature interface's JSDoc points readers at the instance type; a types-test
pins the stamped members compile against both the construction and the alias. `FlareHost` is
the canonical instance.

## Concept budget

Every public noun is earned. Near-synonyms are deleted, not accumulated. When explaining
concept N requires introducing concept N+1, question N+1 first. This rule is review guidance,
not a lint: it binds design sessions and audits, and it is the rule behind removing "engine"
and "sink" from the WebSocket arc rather than documenting them.

## Inference-first factories

Users write values; TypeScript derives the types end-to-end. A public factory whose result
requires manual type annotations to be usable is a violation. The house shape is the
extract-func pattern: `const` type parameters plus inference from the descriptor argument
(`socketContract`, `flareErrorCodes`, `flareConfig`).

Declared exception: explicit type parameters where the descriptor cannot carry the
information. The discriminated-union overloads (`schema<Pet, "union">("kind", ...)`) are the
canonical case: a union cannot be inferred from its branches.

## Sibling names spell their contract difference

When two public exports share a noun and differ in behavior, the NAMES must carry the
difference - a reader comparing the two signatures must be able to state what changes
without opening either body. Two near-twin names with silently opposite contracts
(one drops state a caller expects to cross, one carries it) are a violation even when
each is individually documented: the hover test applies to the PAIR, not each name
alone. The fix is a rename that spells the divergent behavior, or an API fold that
removes the choice.

## Dual-form parity

When a surface offers two authoring forms (function handler and class controller), both feed
ONE shared core and speak ONE vocabulary. Divergence between the forms' behavior is a bug
even when each form individually works. Precedent: the WebSocket arc's resident and
hibernating handlers dispatch through one shared core.

## Brand and phantom idioms

Exactly two marker idioms exist; pick by job, never invent a third, never mix the jobs:

- **Symbol brand whose VALUE carries the kind** - kind discrimination (`CONTRACT_BRAND`,
  `SCHEMA_BRAND`).
- **`_type?: T` optional phantom member** - inference carrier (`ConfigToken`, `ErrorSchema`).

These are MARKER idioms: the member exists only to make the type checkable or inferable.
Symbol-keyed hidden state is a different mechanism, not a third marker: real runtime data
stored behind a symbol key to keep it off the public surface (`SCHEMA_DESCRIPTOR`,
`COMPILED_SERIALIZER`, `UPGRADE_WS`, state's `_DEFAULT` family). Its rules come from
declaration placement (the symbol lives with the declaration it keys), not from this
section.

## Runtime variant pairs are nominal fences

A sync/async class pair (`CfLoggerTransport` vs `LoggerTransport`, `CfLogger` vs `Logger`)
is a deliberate type-level fence: the sync base narrows lifecycle hooks so a variant CANNOT
declare hooks its runtime would mishandle. Never merge the pair and never make the variant
inherit from the other family: TypeScript's void-return assignability makes the wrong
inheritance typecheck while destroying the fence, so a later async hook on the shared parent
is silently dropped at runtime. Deduplicate shared logic behind seams instead (a shared
operations module, a parameterized renderer), keep both classes thin on their own bases, and
pair them with an anti-unification note.
