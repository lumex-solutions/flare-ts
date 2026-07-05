# JSDoc

Rules for the JSDoc on every symbol across `@flare-ts/*` packages, organized by symbol kind so a
declaration can be audited against exactly the rules that apply to it. File-header blocks have
their own document: [file-headers.md](file-headers.md).

## Principles

1. **Describe what, not how.** Public docs describe what a symbol is or does. Implementation
   detail belongs in inline comments (`//`) or `@internal` blocks, never public JSDoc.
2. **Say it once.** Do not restate the type signature in prose. Do not repeat the summary in the
   body.
3. **Silence over speculation.** Unimplemented variants, future behavior, and unstable internals
   are not documented. Silence is correct.
4. **Parallel construction.** Equivalent symbols use equivalent phrasing: within a class or
   module, getters share a verb, builders share a verb, registration methods share a verb. See
   the verb vocabulary below.

## Summary line

The first line of every JSDoc block:

- One sentence. Ends with a period.
- Does not start with the symbol's own name, or with "This", "A", or "An" - go straight to the
  noun or verb.
- Fits one line at 100 characters; if it does not, it is too dense - move secondary content to
  the body.
- Third-person present tense: "Builds", "Returns", "Represents".
- Never includes implementation detail.

## By symbol kind

**Type aliases** - noun phrase describing what the type represents. Never restate the signature
("A union of string literals...").

```ts
/** Supported runtime environments for a {@link FlareHost}. */
export type HostRuntime = "node" | "bun" | "deno" | "cloudflare";
```

For generic aliases, describe what the alias resolves to, not the mechanics of resolution;
`@template` covers a type parameter whose semantics are not obvious from its constraint.

**Interfaces** - noun phrase describing the contract. Properties get a single-line doc only when
name plus type are not self-evident (`port?: number` on an HTTP config needs nothing; a
`drainTimeout` needs its units and semantics).

**Classes** - noun phrase describing what the class IS, never what you do with it ("HTTP server
host for a Flare application.", not "Use this class to..."). Constructor parameters are documented
on the constructor, not the class.

**Methods and functions** - verb phrase in third-person present. For non-void returns, state the
return in the summary OR in `@returns`, never both.

**Properties and accessors** - noun phrase or brief declarative sentence. Never "This property
holds...".

**Constants and unique symbols** - public constants follow the type-alias rule. For `@internal`
constants the tag alone is sufficient; a brief description is acceptable:

```ts
/** @internal Symbol-keyed setter for advancing host state. */
export const SET_HOST_STATE: unique symbol = Symbol("SET_HOST_STATE");
```

## Body

Write a body (prose after a blank line) only when there is genuine secondary information: behavioral
nuances, invariants callers must know, precedence or layering that affects consumers, or union
members with distinct semantics. Never write a body that restates the summary, the signature, or
internal implementation.

**Union member lists**: when a union's members have distinct semantics, document each as a bullet -
the value in backticks, a spaced hyphen, then a sentence-case description ending with a period:

```ts
/**
 * Lifecycle state of a {@link FlareHost}, observable via {@link FlareHost.state}.
 *
 * - `"starting"` - host is initializing; not yet accepting requests.
 * - `"ready"` - server is listening and accepting requests.
 * - `"draining"` - graceful shutdown in progress; new requests receive 503.
 * - `"stopped"` - teardown complete.
 */
export type HostState = "starting" | "ready" | "draining" | "stopped";
```

No editorial commentary on members ("Rarely observed", "The common case").

## Tags

**`@param`** - required when a parameter's purpose is not self-evident from name plus type; omitted
for unambiguous parameters. Format: `@param name - Description.` (name, spaced hyphen, capitalized
description, terminal period). Never include the type; it is in the signature.

```ts
// Correct
@param timeout - Milliseconds to wait for in-flight requests to drain before closing connections.

// Incorrect: restates the name, omits the meaning
@param timeout - The timeout value.
```

**`@returns`** - required on non-void functions when the summary does not capture the return's
meaning; omitted otherwise. The description never starts with "Returns" (the tag implies it) and
never merely restates the type.

**`@throws`** - required for errors that are part of the public contract (a caller might handle
them); omitted for internal panics and programmer errors. Format:
`@throws {ErrorType} When condition description.`

**`@template`** - required when a type parameter's semantics are not obvious from its constraint;
format `@template T - Description.`

**`@internal`** - marks a symbol out of the public API; the tag alone is sufficient.

**`@remarks`** - use sparingly; prefer a body paragraph. Never a smuggling route for
implementation detail.

**`@example`** - only when usage is genuinely non-obvious or the API has a footgun. One example,
correct and minimal, in a fenced `ts` block; no elisions in the meaningful parts.

## `{@link}` cross-references

Link the canonical home of a concept on first mention within a block; never the same target twice
in one block; never primitive JS types; never reflexively (a type does not link to itself). Ask
whether the reader benefits from navigating there - if not, omit.

## Verb vocabulary

Within a class or module, equivalent operations use the same verb. Mixing synonyms ("Gets",
"Returns", "Retrieves") breaks parallel construction.

| Operation                          | Verb                      |
| ---------------------------------- | ------------------------- |
| Pure read / accessor               | `Returns`                 |
| Registration (route, service, arc) | `Registers`               |
| Compilation / graph construction   | `Builds`                  |
| Validation only                    | `Validates`               |
| Removal                            | `Removes` / `Deregisters` |
| Initialization / startup           | `Initializes`             |
| Shutdown / teardown                | `Stops` / `Drains`        |

An operation that does multiple things captures both: "Builds the route graph and returns a
compiled application instance."

## Prohibited patterns

Never acceptable, regardless of context:

- A summary starting with "This", "A", "An", or the symbol's own name.
- Restating the type signature in prose.
- Internal implementation in a public doc block.
- Documenting unimplemented or future variants.
- Commented-out code inside a JSDoc body.
- Editorial filler ("Rarely observed", "The common case", "Typically used when...",
  "Note that...").
- `{@link}` used twice for the same target in one block.
- A `@returns` description starting with "Returns".
- A `@param` description that only restates the parameter name.
- A body paragraph containing nothing the summary did not already say.
- The em dash character, anywhere. Use a spaced hyphen or a colon.
