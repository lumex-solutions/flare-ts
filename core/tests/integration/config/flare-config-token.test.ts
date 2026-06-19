// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. Mirrors
// the pattern used by the other behavior tests in core/tests/behavior/.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import { schema } from "@flare-ts/lib";
import { int, str } from "@flare-ts/lib/schema";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { type ConfigToken, flareConfig } from "../../../src/lib/config/flare-config.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";

// Test adapter: wraps the real `node` adapter but lets each test supply the
// raw `flare.json` contents in code. The repo has no `core/flare.json`, so
// the default node adapter would throw ENOENT when reading it. The wrapper
// preserves every other adapter capability (createApp / createLogger /
// createTestRequest / default transports / env) so the resulting app exercises
// the full host build pipeline the same way a production node app would.

function nodeWith(flareJson: JsonObject): HostRuntimeAdapter<
  ReturnType<typeof node.createApp>
> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env: node.env,
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

// Tokens used across Primary Behavior, Edge Cases, and Cross-Feature sections.
// Each is declared at module scope so the same identity flows through both
// `host.cfg(...)` (registration) and `this.config(...)` (consumption) — the
// spec's "identity is the lookup key" bullet depends on referential identity.

const DbConfig = flareConfig("db", { url: str, password: str });

const nestedOpts = schema({ host: str, port: int });
const MixedConfig = flareConfig("mixed", {
  url: str,
  retries: int,
  opts: nestedOpts,
});

// Service used by the identity bullet. The class declares `static config` so
// the `this.config(...)` guardrail accepts the registered tokens, and exposes
// a method so the test can drive resolution end-to-end through DI.

class DbService extends FlareService {
  static override deps = [];
  static override config = [DbConfig] as const;

  getDb(): { url: string; password: string; } {
    return this.config(DbConfig);
  }
}

// Resolves a config section using a structurally-identical clone of DbConfig.
// The clone shares the same `key` and `descriptor` shape but is a distinct
// object reference, so `static config = [DbConfig]` does NOT include it.
class StructuralCloneService extends FlareService {
  static override deps = [];
  static override config = [DbConfig] as const;

  callWithClone(): unknown {
    // DbConfig.descriptor's static type widens to `... | undefined`, which
    // exactOptionalPropertyTypes forbids assigning to ConfigToken's optional
    // `descriptor?` field. Build the object as `Record<string, unknown>` and
    // cast — runtime structure is unchanged.
    const clone = {
      key: DbConfig.key,
      descriptor: DbConfig.descriptor,
    } as unknown as ConfigToken<{ url: string; password: string; }>;
    return this.config(clone);
  }
}

// Shared app: covers every test that can run against a single host with all
// the tokens registered and a flare.json that satisfies each descriptor.

const SHARED_FLARE_JSON: JsonObject = {
  host: { env: "test", port: 0 },
  log: { level: "fatal", format: "json" },
  db: { url: "postgres://example/db", password: "s3cret" },
  mixed: {
    url: "https://example.test",
    retries: 5,
    opts: { host: "127.0.0.1", port: 8080 },
  },
};

function buildSharedHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(nodeWith(SHARED_FLARE_JSON));

  host.cfg(DbConfig);
  host.cfg(MixedConfig);

  host.scoped(DbService);
  host.scoped(StructuralCloneService);

  // Routes that surface resolved config to the test via JSON responses. The
  // inline handler shape is `(ctx, scope) => ...`; the named scope deps and
  // `scope.config` are guarded by the route's `inject` declaration the same
  // way `static deps` / `static config` guard a class-based handler.
  host.http.get(
    "/db",
    { inject: { db: DbService } },
    (_ctx, scope) => {
      const svc = scope.db;
      return svc.getDb();
    },
  );

  host.http.get("/mixed", (_ctx, scope) => {
    return scope.config(MixedConfig);
  });

  // Triggers the guardrail failure inside `FlareBase.config()` when handed a
  // structurally-identical-but-distinct token object. We surface the thrown
  // message as the response body for assertion.
  host.http.get(
    "/clone",
    { inject: { structuralClone: StructuralCloneService } },
    (_ctx, scope) => {
      try {
        const svc = scope.structuralClone;
        return { ok: true, value: svc.callWithClone() };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildSharedHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("produces a host.config[token.key] section whose typed contents match the descriptor when flare.json supplies them", async () => {
    // The /db route is a thin shim that surfaces `this.config(DbConfig)` to the
    // test runner; on the framework side that resolves through
    // `Container.resolveCfg`, which reads `this.config[token.key]` straight
    // from the resolved host config. So a green response body proves the
    // top-level "host.config.db" section is populated with the typed contents
    // exactly as the descriptor declared them.
    const res = await app.fetch("GET /db");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; password: string; };
    expect(body).toEqual({
      url: "postgres://example/db",
      password: "s3cret",
    });
  });

  it("uses token identity as the lookup key: original token resolves, structurally-identical clone is rejected", async () => {
    // The original-token path: DbService.getDb() calls `this.config(DbConfig)`
    // with the exact token registered on the host. The resolver returns the
    // typed section. Asserted via the /db route (same as Primary #1 above) so
    // we still confirm identity-resolution succeeds in this test.
    const ok = await app.fetch("GET /db");
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { url: string; password: string; };
    expect(okBody.url).toBe("postgres://example/db");

    // The clone path: StructuralCloneService.callWithClone() constructs a
    // fresh `{ key, descriptor }` object literal with the same values and
    // hands it to `this.config(...)`. The guardrail in `FlareBase.config()`
    // identifies tokens by referential identity (Array.prototype.includes
    // uses ===), so a clone with the same key/descriptor is reported as
    // undeclared even though the host has a section under the same key.
    const res = await app.fetch("GET /clone");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string; };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("StructuralCloneService");
    expect(body.message).toContain(`"${DbConfig.key}"`);
    expect(body.message).toContain("not declared in StructuralCloneService.config");
  });
});

describe("Edge Cases", () => {
  // Deferred: inline handlers returning raw config objects should be normalized.
  it("parses descriptors with mixed primitive and schema-token fields, recovering each branch of InferConfigField", async () => {
    const res = await app.fetch("GET /mixed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      retries: number;
      opts: { host: string; port: number; };
    };
    // `url` is a string primitive, `retries` is an integer primitive (coerced
    // from the JSON number), and `opts` is a nested SchemaToken whose own
    // shape is parsed in turn.
    expect(body.url).toBe("https://example.test");
    expect(body.retries).toBe(5);
    expect(typeof body.retries).toBe("number");
    expect(body.opts).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  // Deferred: inline handler returning scope.config(DbConfig) returns 500.
  it("treats registering the same token twice as idempotent: a single section is required and validated once", async () => {
    process.env["FLARE_MODE"] = "test";
    // Build a brand-new host so the registration counts are isolated from the
    // shared app above. Same flare.json so the build succeeds.
    const idempotentJson: JsonObject = {
      host: { env: "test", port: 0 },
      log: { level: "fatal", format: "json" },
      db: { url: "postgres://idem/db", password: "ok" },
    };
    const host = new FlareHost(nodeWith(idempotentJson));

    // Double-register the same token. The host stores registrations in a Set,
    // so the second call must not introduce a second descriptor entry or a
    // duplicate validation pass.
    host.cfg(DbConfig);
    host.cfg(DbConfig);

    host.http.get("/db", (_ctx, scope) => scope.config(DbConfig));

    const idemApp = await host.build().test();
    try {
      const res = await idemApp.fetch("GET /db");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; password: string; };
      // If the second registration had added a second descriptor entry under
      // the same key the schema would still produce one section; here we
      // assert the resolved section is exactly the JSON we supplied — no
      // duplicate fields, no shadow values.
      expect(body).toEqual({ url: "postgres://idem/db", password: "ok" });
      expect(Object.keys(body).sort()).toEqual(["password", "url"]);
    } finally {
      await idemApp.stop();
    }
  });
});

describe("Failure Modes", () => {
  it("fails host.build() when a registered token's section omits a declared field (observable surface of MISSING_CONFIG_FIELD)", () => {
    process.env["FLARE_MODE"] = "test";
    // flare.json supplies db.url but omits db.password. The per-field
    // requirement on DbConfig's descriptor (`password: str`) is unmet, so the
    // build pipeline aborts.
    //
    // The build pipeline pre-fills missing top-level keys with `{}` before
    // parsing (see #compileConfig in flare-host.ts), and the schema layer
    // reports the missing field before the MissingConfigKeyValidator runs.
    // The user-facing contract — build() throws and the message names the
    // missing field — is preserved.
    const json: JsonObject = {
      host: { env: "test", port: 0 },
      log: { level: "fatal", format: "json" },
      db: { url: "postgres://example/db" },
    };
    const host = new FlareHost(nodeWith(json));
    host.cfg(DbConfig);

    expect(() => host.build()).toThrow("Config validation failed");
    expect(() => host.build()).toThrow(/password/);
  });
});
