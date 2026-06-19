// Ambient types for the workerd-pool tests: the wrangler bindings (FLAG var + TEST_ROOM Durable
// Object) and the bits of the `cloudflare:test` module the DO tests use. The pool's `./types` export
// is not published in this version, so these are declared locally; the runtime modules are real.

declare namespace Cloudflare {
  interface Env {
    FLAG: string;
    TEST_ROOM: DurableObjectNamespace;
  }
}

declare module "cloudflare:test" {
  export const env: Cloudflare.Env;
  export function runInDurableObject<T>(
    stub: DurableObjectStub,
    callback: (instance: unknown, state: DurableObjectState) => T | Promise<T>,
  ): Promise<T>;
  export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
}
