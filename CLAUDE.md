# Working in flare-ts

## Standards

`standards/` is how code is written here, and its [README](standards/README.md) is the index. Each section is a few principles, small enough to hold while working.

- Before writing a new module, subsystem, or test suite, or changing how existing code is shaped, read the sections that govern that work and follow them. A one-line fix or a rename needs only what it touches.
- The standards are the rules. Where one is silent, follow the code around you; where one seems wrong for the work, say so and ask, rather than working around it.
- A standard changes only in a design conversation with the developer, never to make code you just wrote pass. Read `standards/meta/` before proposing a change to one.

## Working on a change

- An approval covers what was asked, read narrowly. Anything wider, such as another file, a rename, or a moved type, is proposed and waits for a yes.
- A change touches only what it needs. Do not move, rename, reformat, or tidy code in passing. A field of anything stored or sent, such as a socket attachment, a stored value, or a wire frame, is renamed only with a plan for what is already written.
- Reproduce a bug before fixing it, with the real data where it can be had, and pin it with a test that fails before the fix and passes after.
- Names are the developer's. When a new name is needed, offer candidates and wait. Never swap in your own for one the developer leaned toward.

## Review skills

Each review skill audits one file or a small folder against one section. Run the ones that apply to the files you touched when you finish a module, a subsystem, or a suite, before calling the work done. They are not for a one-line change or a sweep of the whole repository.

- `flare-organization`: reason for existing, state, lifetime, and frequency, seams and wiring, file kinds, placement, naming, and public surface.
- `flare-comments`: file headers, symbol docs, and inline notes.
- `flare-testing`: test suites, when tests are written or changed.

`standards/skills/` holds the source of each skill; [INSTALL.md](standards/skills/INSTALL.md) says how to install one.

## Gates

Run the gates as [testing](standards/testing/testing.md) says, once at the end of a change, for the packages it touches.

NEVER add yourself as a co-author on git commits.
