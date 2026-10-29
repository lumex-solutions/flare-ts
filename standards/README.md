# Standards

How code is written in flare-ts, for people and for the AI systems that work in it.

A standard exists to make a choice intentional: a design, a name, a comment, a test, each able to say what it is for. Without one, work drifts toward what looks right, and what looks right is a guess drawn from other people's code.

## Layout

- [meta/](meta/) - the standards for the standards: [what-a-standard-is.md](meta/what-a-standard-is.md) says what a document here may and may not contain, and [power-of-few.md](meta/power-of-few.md) says why every section is governed by 3 to 5 principles.
- [code/](code/) - how code is written: [fundamentals](code/fundamentals.md), whether code should exist and how plainly it is written; [structure](code/structure.md), what shape it takes and how often it runs; [types](code/types.md), how it presents what it holds; [async work](code/async.md), how work in flight waits and stops; and [errors and logs](code/errors-and-logs.md), how it reports what went wrong and what it did.
- [organization/](organization/) - where code lives and what it is called: [organization](organization/organization.md), with its detail on [file kinds](organization/file-kinds.md), [subsystems](organization/subsystems.md), [declarations](organization/declarations.md), and [naming](organization/naming.md); and [surface](organization/surface.md), what a consumer of a flare package sees.
- [comments/](comments/) - [comments](comments/comments.md), with its detail on [file headers](comments/file-headers.md), [symbol docs](comments/jsdoc.md), and [inline notes](comments/inline-comments.md).
- [testing/](testing/) - [testing](testing/testing.md), with its detail on [choosing a test](testing/choosing-tests.md), [doubles and idioms](testing/doubles-and-idioms.md), [the suite layout](testing/structure.md), and [conformance and probes](testing/conformance-and-probes.md).
- [skills/](skills/) - the audits an AI system runs against a file.

## How to use

- **Writing code**: open the section for the work at hand and hold its principles while you work. Every section is small enough for that on purpose.
- **Reviewing**: the principles are what to point at. They do not cover everything and are not meant to; the rest is judgment, and each document says where judgment sits.
- **Changing a standard**: read [meta/](meta/) first. A standard changes when the law changes, never to trail an implementation.
