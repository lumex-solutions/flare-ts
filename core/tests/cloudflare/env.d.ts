/**
 * Ambient types for workerd-pool Cloudflare tests. The `cloudflare:test` module surface comes from
 * the pool's published types; this file declares only the project-specific wrangler bindings the
 * tests use.
 */
/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    FLAG: string;
    TEST_ROOM: DurableObjectNamespace;
    // Convention-router binding: namespaceFor(env, TestRoom) looks up env[cls.name] = env.TestRoom.
    TestRoom: DurableObjectNamespace;
    // State boundary-crossing e2e test bindings.
    ROOM_DO: DurableObjectNamespace;
    // Convention-router binding for RoomDO.
    RoomDO: DurableObjectNamespace;
  }
}
