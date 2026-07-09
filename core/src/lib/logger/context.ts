/**
 * The log-context scope: the AsyncLocalStorage carrying the active context and state,
 * and the operations that enter, snapshot, and re-enter it.
 */
// Runtime-specific import is sound here: all four runtimes support `node:async_hooks`
// (CF Workers via the nodejs_compat flag, a documented platform requirement for Flare).
// eslint-disable-next-line no-restricted-imports
import { AsyncLocalStorage } from "node:async_hooks";
import type { LogContext, LogState } from "./types.js";

/** Payload of an active logger-context store entry. */
export type LogStore = {
  context: LogContext;
  state?: LogState;
};

/**
 * AsyncLocalStorage that carries the active log context and state for the
 * current request scope.
 *
 * Populated by the host on entry, read by the logger on every emit when
 * `log.enableContext` is `true`. The context does not automatically flow into
 * CF Workers `waitUntil()` callbacks: deferred work that needs request context
 * snapshots the store with {@link captureLogStore} and re-enters it with
 * {@link runWithLogStore} inside the callback.
 */
export const loggerALS = new AsyncLocalStorage<LogStore>();

/** The context-entering call wrapper {@link loggerRunner} builds: runs a call under a logger context, or passes through when none. */
export type LogRunner = <R>(fn: () => R) => R;

/**
 * Builds a {@link LogRunner} for `context`.
 *
 * When a context was built, every call the runner wraps runs under {@link loggerALS} so
 * records emitted inside carry that context; without one it passes through. Used by
 * long-lived scopes (e.g. a WebSocket connection's handlers) that wrap many calls under
 * one context.
 */
export function loggerRunner(context: LogContext | undefined): LogRunner {
  return context
    ? <R>(fn: () => R): R => loggerALS.run({ context }, fn)
    : <R>(fn: () => R): R => fn();
}

/**
 * Snapshots the currently active log store so detached callbacks (for example,
 * Cloudflare `waitUntil`) can re-enter the same logging scope later.
 */
export function captureLogStore(): LogStore | undefined {
  const store = loggerALS.getStore();
  if (!store) return undefined;
  return {
    context: { ...store.context },
    ...(store.state ? { state: { ...store.state } } : {}),
  };
}

/**
 * Runs `fn` inside the provided log store.
 *
 * When `store` is undefined, runs `fn` without entering AsyncLocalStorage.
 */
export function runWithLogStore<T>(store: LogStore | undefined, fn: () => T): T {
  if (!store) return fn();
  return loggerALS.run(store, fn);
}
