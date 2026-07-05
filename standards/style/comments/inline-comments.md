# Inline comments

Rules for `//` and `/* */` comments inside function bodies and between declarations. JSDoc has its
own document: [jsdoc.md](jsdoc.md).

## The one job

An inline comment states what the code cannot: the WHY, the constraint, the invariant, the
rejected alternative. If a comment restates what the next line visibly does, delete the comment.

```ts
// Correct: names the constraint the code cannot express
// Singletons take priority - they are pre-created and never re-instantiated.

// Wrong: restates the code
// increment the counter
count++;
```

## Hard bans

- **Em dashes.** Use a spaced hyphen or a colon.
- **Decorative dividers** - lines of dashes or equals used as section separators
  (`// ------- Section -------`). Structure comes from file organization, not banners.
- **Arrow and decoration symbols** used decoratively (`->` chains as prose, emoji).
- **Filler preambles**: "Note that...", "It's worth mentioning...", "As you can see...",
  "Simply...".
- **Redundant-obviousness comments** (`// call the handler` above `handler()`).
- **Commented-out code blocks.** Delete the code; version control remembers it.
- **Plan-relative and history-relative language**: "Task 2", "Plan 3", "replaces the old X",
  "unchanged from", branch or session references. The comment describes the present; version
  control owns history.

## Required pairing notes

Some constructs are only acceptable WITH a comment. The comment is part of the construct:

- **Casts and `unknown`-typed seams** carry a plain inline note (not JSDoc) immediately above or
  beside them: what the value really is, and why the type system cannot see it here. This applies
  where the type system is being overridden (`as`, `as unknown as`, a declared `unknown`), never
  to ordinary declarations using a proper type - annotating with the right type needs no comment.
  Vague notes (`// unknown for now`) do not count.

  ```ts
  // The cast restates what erasure loses: every value reaching `serialize` came through
  // `ws.send` typed `WebSocketOutgoing<T>` from the same declared schema.
  serialize: compileSerializer(outgoing) as (data: unknown) => string,
  ```

- **Intentional fire-and-forget promises** carry a note saying the drop is deliberate.
- **Lint suppressions** (`eslint-disable-next-line ...`) carry a note explaining why the exception
  is sound.

## House idioms

These recurring comment shapes are the codebase's way of documenting seams; use them where they
apply.

- **Uniqueness notes** - ALL-CAPS `ONE` marks a deliberately singular thing: "the ONE rejection
  policy every backing shares", "ONE channel registry per arc". The capitals flag an invariant:
  if you are about to create a second, stop.
- **Anti-unification notes** - a deliberate divergence between look-alike code paths is paired
  with an explicit instruction: "Same decode SHAPE, deliberately different failure CONTRACTS -
  do not unify them." Without the note, the next reader merges them.
- **Parallelism notes** - "Mirrors {@link HttpArc}", "same match shape as HttpArc.fetch". They
  tell the reader where the pattern's twin lives, so the two are evolved together.
- **Decision records** - a rejected approach worth not re-trying gets a `NOTE:` with the evidence:
  "NOTE: hoisting this allocation benchmarked -4% to -17%; it deopts V8's inlining." Numbers
  beat adjectives.
- **Sentinel notes** - a field doing double duty says so: "always set once built, so it doubles
  as the 'has build() run?' sentinel".
- **ALL-CAPS emphasis** (`NOT`, `SAME`, `RAW`, `LIVE`, `ONE`) spotlights the load-bearing word of
  an invariant. Use it for invariants, not decoration.

## TODOs

A TODO states the pending work in plain functional terms and nothing else. No owner names, no plan
or ticket cross-references that will not survive the plan, no apology.

```ts
// TODO: Move into a /node folder, extract types, multiple files for main pieces
```
