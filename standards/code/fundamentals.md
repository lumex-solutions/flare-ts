---
title: Fundamentals
description: Whether a piece of code should exist and how it is written: written on purpose and understood, with a reason it can state, resting on checked facts, in the plainest form that does the job.
---

# Fundamentals

Whether a piece of code should exist at all, and how plainly it is written: a class, a function, a helper, a dependency, an abstraction, or a single line. Every other standard assumes these.

## Principles

1. **Everything is intentional.** Every line is there because someone decided it should be, and understood it and its design when they did. Code written with an AI agent arrives fast and looks right, which makes it easy to accept without reading. Accepting it is writing it: the developer who keeps it can say why each part is there and why it has the shape it has, or it does not go in. Code nobody chose is code nobody can defend, change, or fix with confidence.

2. **Everything that exists can say what it is for.** Before a class, a layer, an interface, a helper, or a dependency exists, one sentence says what it is for. "It looked right", "frameworks usually do this", and "we might need it" are not reasons. Code that cannot produce its sentence does not exist yet, because code without a reason is still read, kept, and worked around by everyone after.

3. **A reason that rests on a fact is checked, not remembered.** When the sentence depends on how a runtime, a platform, a library, or a specification behaves, that behaviour is checked against its documentation or a small experiment before the code is written. A remembered fact is a guess, and a guess built into code fails where nobody looks for it.

4. **Plain beats clever.** The straightforward construct wins: a value over an accessor that returns it, a call over an indirection, a built-in over a hand-rolled helper, a line of code over a comment explaining a line of code, three plain lines over one dense one. A helper is earned by repeated use, never by its first caller. Code is read far more often than it is written, by people who did not write it, so it is written for them. Code on the per-request path may be less plain when a measurement shows the plain form is slower, and the measurement is written beside it.

## Deciding, in order

When code "looks right" and no one can say why, walk this before writing it:

1. State its sentence (principle 2). If the sentence is about a future that has not arrived, the code is not written.
2. Find the facts the sentence rests on and check them (principle 3).
3. Ask whether a plainer construct does the same job (principle 4), and use it if one does.

## Branching (principle 4)

- A ternary chooses between two values, never between two actions, and is never nested. Work that differs by branch is an `if` with a statement in each branch, and a choice among more than two values is an `if` chain or a lookup, so each path reads on its own line.

```ts
// Right: the work differs, so each branch is a statement
if (hibernatable) ctx.acceptWebSocket(server);
else server.accept();

// Wrong: two actions folded into one expression
hibernatable ? ctx.acceptWebSocket(server) : server.accept();

// Wrong: a nested ternary
const level = status < 400 ? "info" : status < 500 ? "warn" : "error";
```

## Measured exceptions (principle 4)

- A form chosen for speed over plainness carries a `NOTE:` with the measurement that chose it, in the shape [inline comments](../comments/inline-comments.md) gives decision records. Without the numbers, the plain form wins.
- A measurement is of the path it claims to speed up, on the runtime that runs it.

## Where judgment sits

Whether a reason is good enough is the developer's call, made by saying it out loud in review. Whether a measured gain is worth the plainness it costs is the same kind of call, made from the numbers. What no one decides alone is a new dependency or a new package: those are design conversations first.
