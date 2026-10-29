---
title: Async work
description: How work that waits or runs over time behaves: async only where the work waits, every wait bounded, and every piece of work stoppable.
---

# Async work

How work behaves while it is in flight: a function that returns a promise, a call that waits on another system, and a timer or loop that runs over time.

## Principles

1. **Work is async only where it waits, and whether a function is sync or async is part of its contract.** A function returns a promise because it waits on something, never because its neighbours do. Each `await` on the per-request path costs a turn of the microtask queue, so sync work stays sync. Where a contract accepts either, such as a hook typed `void | Promise<void>`, the type says so, and the caller handles both: a returned promise is awaited, and a plain return is not wrapped in one. Turning a sync function async, or the reverse, is a change to its contract, since every caller that relied on the old one is now wrong.

2. **Every wait is bounded.** A wait on something flare does not control, such as a socket's peer, a request still draining, or a developer's hook, has a timeout. A wait with no bound is how one slow peer holds a connection, a shutdown, or an isolate open forever.

3. **Every piece of work can be stopped.** Work takes the `AbortSignal` of what it belongs to, such as its request, and passes it to every call it makes. Stopping stops taking new work, gives the work in flight a bounded time to finish, then aborts what is left, so a shutdown or a cancel ends promptly and never leaves work half done without knowing it.

## Sync and async variants (principle 1)

- Two runtime variants of one concept where one is sync and the other async are two classes on their own bases, never one inheriting from the other ([surface](../organization/surface.md)).

## Waiting and stopping (principles 2 and 3)

- A timeout is a named constant or a configuration value, never a number inline.
- A promise is awaited, or dropped on purpose with the note [inline comments](../comments/inline-comments.md) requires, so no work runs that nothing can stop or wait for.
- A timer or loop owned by a long-lived object keeps the handle it needs to stop it, and the object's stop clears it and waits for the run in flight within its bound.

## Where judgment sits

How long a timeout is, and what its default is, is decided by the developer per wait, from how the other side behaves and what the caller is waiting to do.
