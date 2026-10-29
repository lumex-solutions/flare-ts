---
title: Errors and logs
description: How code reports what went wrong and what it did: faults thrown and outcomes returned, every error handled once where something can be done, logs a stranger can read, and declaration mistakes refused at build.
---

# Errors and logs

How code reports what went wrong and what it did.

## Principles

1. **A fault is thrown, an outcome is returned.** "Not found", "refused", and "did not match" are answers the caller handles, so they are values in the return type, where the compiler makes the caller deal with them: a `safeParse` result, a refusal an upgrade hook returns. A lost connection or a broken invariant is a fault no caller can answer, so it is thrown. The one designed exception is `FlareError`: a developer's handler throws it to end a request with a response, and the pipeline turns it into that response in one place.

2. **An error is handled once, where something can be done about it.** The handler is the code that can answer the caller, close the socket, or give up, and it logs the error once, with what it knows. Code between the fault and the handler lets it pass without catching it. An error is never swallowed, and never logged at every layer it crosses, so one failure is one log line. Every path a developer's code runs on hands its errors to the same handler, so a failure is treated alike however it arrived.

3. **A log is written for a stranger at two in the morning.** A line is structured, carries the ids that tie it to the work it belongs to, such as a request or a Durable Object, and says what happened in plain words. Someone who has never read flare's code can follow one piece of work through the logs by its id.

4. **A mistake in how an app is declared is refused at build, never found at a request.** A duplicate route, a dependency that was never registered, a scoped service held by a singleton: anything the build can see is checked at build, refused with a stable code such as `CAPTIVE_DEPENDENCY`, and named in the developer's terms, so it fails on the developer's machine instead of in production. A check that waits for a request finds the mistake on whichever request reaches it first.

## Writing a log line (principle 3)

- The message is a fixed string naming the step, and what varies goes in the structured fields, so lines of one kind can be found and counted.
- An error is passed to the logger as the error itself, so its stack and cause are kept.
- A log never holds a secret, a credential, a cookie, or personal data beyond the ids needed to find the record.

## Refusing at build (principle 4)

- Each refusal carries a stable code, a message naming what was declared, and a hint saying what to do instead. A published code is a schema ([types](types.md), principle 4): it is renamed only with a plan.
- Every check runs and returns its refusals, and the build reports all of them in one error, so a developer fixes them in one pass.

## Where judgment sits

Whether an answer is an outcome or a fault is sometimes a close call, made by asking whether any caller can act on it. Whether a check can run at build or must wait for the request is decided by what the build can see.
