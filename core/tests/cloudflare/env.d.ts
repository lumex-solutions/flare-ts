/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Ambient types for the workerd-pool tests. The `cloudflare:test` module surface (env,
// runInDurableObject, runDurableObjectAlarm, reset, abortAllDurableObjects, ...) comes from the pool's
// published `./types`, referenced above. We only declare the wrangler bindings the tests use — those
// are project-specific, so the pool cannot supply them.

declare namespace Cloudflare {
  interface Env {
    FLAG: string;
    TEST_ROOM: DurableObjectNamespace;
    // Convention-router binding: namespaceFor(env, TestRoom) looks up env[cls.name] = env.TestRoom.
    TestRoom: DurableObjectNamespace;
    // State boundary-crossing e2e test bindings (Task 8).
    ROOM_DO: DurableObjectNamespace;
    // Convention-router binding for RoomDO.
    RoomDO: DurableObjectNamespace;
  }
}
