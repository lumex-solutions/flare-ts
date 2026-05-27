/** Lifecycle flavour for a runtime: `"sync"` rejects Promise-returning hooks, `"async"` awaits them. */
export type HostRuntimeLifecycle = "sync" | "async";

/** Shape of an `onStart` / `onStop` callback, narrowed by the host runtime's lifecycle flavour. */
export type LifecycleCallback<TLifecycle extends HostRuntimeLifecycle> = TLifecycle extends "sync" ? () => void
  : () => void | Promise<void>;
