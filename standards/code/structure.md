---
title: Structure
description: What shape a piece of code takes: a class only for state, a lifetime that follows the state, a seam only where a second implementation or a boundary needs one, a class that shows only what its callers use, and work placed at the least frequent point that can do it.
---

# Structure

What shape a piece of code takes once it has earned its place: a class or a function, how long it lives, whether something stands between it and its caller, what it shows to the code that uses it, and how often it runs.

## Principles

1. **State decides shape.** A class exists to hold state; everything without state is a function, imported and called. A value merely derived from configuration, such as a parsed secret, is configuration and lives there, not in a class that caches it. A class with nothing to hold is a namespace with extra steps, and every reader has to check that it really holds nothing.

2. **State decides lifetime.** State that lives as long as the process or isolate belongs to a singleton. State for one request belongs to a scoped service. State for one piece of work, such as one build or one call, belongs to a plain object made by the code that owns that work, and is not registered. When the lifetime matches the state, nothing outlives what it holds or forgets it early.

3. **A seam exists where a second production implementation exists, or where code that may not import an implementation must still name what it uses.** An interface or an abstract class is warranted by two implementations that ship, such as one per runtime, or by a boundary that forbids the import: portable code names the contract a runtime implements, and the runtime's implementation is handed in. Tests are not a second implementation: a test stands in for a concrete class with any object that has its public surface. A wrapper whose whole body is one field over a platform object is not an abstraction, it is a name for the object.

4. **A class shows only what its callers use.** Everything else is `#private`. A constructor takes the collaborators the class uses, each by name, never a bag of them, so its signature is the list of what it depends on. A smaller surface is less to read, less to keep working, and less for a test to stand in for.

5. **Work runs at the least frequent point that can do it.** Flare's work happens at one of a few frequencies: at build, once per isolate or process, once per Durable Object instance, once per connection, or once per request. Anything that can be decided earlier is decided earlier: a route table at build, a serializer compiled once, never per request. The per-request path is paid on every request the app ever serves, so it carries only what cannot be known before the request arrives.

## Deciding, in order

When a shape "looks right" and no one can say why, walk this before writing it:

1. Ask what state it holds (principle 1). None: a function.
2. Ask how long that state lives (principle 2). The process or isolate: a singleton. A request: scoped. One piece of work: a plain object its owner makes.
3. Count its production implementations (principle 3). One: no seam, unless a boundary forbids the import.
4. List what its callers use (principle 4). The rest is private.
5. Name how often it runs (principle 5). If it runs per request, say why it cannot run earlier.

## Methods and functions (principle 1)

- A function is an instance method if and only if it reads or writes `this`. Otherwise it is a module function.
- `static` is reserved for construction-adjacent factories that must be reachable through the class, such as `HibernationChannelIndex.for(state)`. A static that never touches the class is a module function wearing a badge.
- Performance does not override this: V8 inlines every form in hot code, and a module function is never slower in cold code, so the state rule is also the fast choice.

## Lifetime (principle 2)

- A singleton never holds a scoped service: it would keep one request's state alive for every request after it. The build refuses it as `CAPTIVE_DEPENDENCY`.
- A singleton that holds only a reference to another singleton is a wrapper and is deleted.

## Signatures (principle 4)

- A function or constructor that needs part of a larger object takes exactly the fields it reads, as a `Pick` of that object's type, so its signature states its dependency.

## Frequency (principle 5)

- A change names, for each operation it adds, the frequency it runs at. An operation added to the per-request path needs a measurement of what it costs there.
- A change to how an app is composed runs at build or once per isolate, and leaves the per-request path as it was.

## Where judgment sits

Whether a piece of state lives as long as the process or only for a request is sometimes a product question: how long a thing must survive and who must see it. The developer decides it and the decision appears in the class's own doc comment. What no one decides alone is a new seam: that is a design conversation first.
