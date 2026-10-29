---
title: Types and contracts
description: How code presents itself to other code: types that admit only real states, type for data and interface for contracts, outside data checked once where it enters, and stored or sent shapes treated as schema.
---

# Types and contracts

How a type, an interface, or a function's signature presents what it holds to the code that uses it.

## Principles

1. **A type admits only the states that can exist.** Something that comes in kinds is a union of objects tagged by a literal field, never a set of optional fields and booleans whose valid combinations live in someone's head. When the type cannot hold a wrong state, no code has to check for one, and the compiler finds every place a new kind must be handled. `any` is never written, and an `as` cast or an `unknown` means the type is wrong somewhere, unless it is one of the declared seams below.

2. **`type` for data, `interface` for a contract a class implements.** Data is what code passes around and writes as literals: a definition, a record, a message, a result. A contract is the surface a class promises so another can stand in for it, and [structure](structure.md) decides when one may exist. The keyword tells the reader which one they are looking at before they read a field.

3. **What comes from outside is checked once, where it enters, and trusted after.** Outside is anything flare did not write in the same process: a request, a frame, the environment, a config file, and anything read back from storage or a hibernated socket. Each is unknown until a schema or a guard checks it at the boundary, and inside, code relies on the type and never checks again. A check scattered through the code means the boundary was never drawn, and the next path in skips it.

4. **A shape that is stored or sent is a schema.** Once a value is written to storage, a socket attachment, a config file, or the wire, its field names and meanings outlive the code that wrote them, and survive a deploy. Renaming or repurposing a field is a change to the schema, made with a plan for what is already written, never as a tidy-up, and a reader that meets an old shape still reads it.

## Kinds and unions (principle 1)

- One family of shapes uses one tag name. A new family tags by `kind`, and a shape that mirrors an outside one, such as a platform's event, keeps that system's tag.
- A fixed set of names is an `as const` object or a union of string literals, never an `enum`, which Node's type stripping rejects.
- A `switch` that must handle every kind has no `default`, so a new kind fails to compile where it is not yet handled. A `switch` with a `default` handles only some kinds on purpose, and its `default` says what the rest have in common.
- A generic parameter exists only where the caller chooses it, directly or through the value the compiler infers it from, and gets type safety from it.

```ts
// Right: each kind carries exactly what it has
type Accepted = { kind: "accepted"; protocol: string; };
type Refused = { kind: "refused"; status: number; };
type Upgrade = Accepted | Refused;

// Wrong: protocol and status can both be set, or neither
type Upgrade = { ok: boolean; protocol?: string; status?: number; };
```

## Declared seams (principle 1)

An `unknown` or a cast is one of these, and carries the note [inline comments](../comments/inline-comments.md) requires, naming which:

- **A boundary before its check**: a value from outside, held as `unknown` only until the one guard that checks it (principle 3).
- **Erasure in a heterogeneous collection**: values of different types stored together, where TypeScript cannot say which type each one is. The note states the pairing that makes the cast true, such as "the value out of validate is the type the sibling handler expects".
- **A caught error**, which is `unknown` by the language's rule.

Everything else has a precise type:

- A value out of `JSON.parse` is `JsonValue`, never `unknown`: JSON's domain is exactly that type.
- An erased function in storage is bounded as `(...args: never[]) => unknown`, never `any[]`, so it cannot be called without narrowing.
- Shared infrastructure that serves more than one shape is generic over its base, such as `<Base>(scope: Base) => Base & Added`, instead of casting to one caller's shape.

## Contracts (principle 2)

- `implements` names an interface, never a type alias. A class whose shape is checked where it is used, with no declared contract, is just a class.
- An `interface` is also how a platform's or a library's declaration is extended, since only an interface merges with another of the same name.

## Boundaries (principle 3)

- A shape checked at a boundary is declared as a schema where the boundary is owned, so the type and the check come from one declaration and cannot drift apart. A shape only flare writes and reads in the same process is a plain type.
- A round trip flare both writes and reads is typed at the writer, so the writer cannot write a wrong shape. The reader keeps its guard, because what it reads may have been written by an older deploy (principle 4).
- A value a platform types too loosely, such as `deserializeAttachment(): any`, is never consumed directly: it passes through the guard for the shape the code relies on.
- A value that fails its check is the sender's error, reported in the sender's terms. It is never coerced into something that passes.

## Where judgment sits

Whether a value is data or a contract is sometimes a close call, made by asking whether a class will implement it. Whether a stored shape can change without a plan, because nothing durable holds it yet, is checked against where it is written, never assumed.
