process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { int, str } from "@flare-ts/lib/schema";
import type { ConfigToken } from "../../../src/lib/config/flare-config.js";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import { flareConfig, LOG_CONFIG } from "../../../src/lib/config/flare-config.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { LoggerTransport } from "../../../src/lib/logger/transport.js";
import { registerMinimalPingRoute } from "../../helpers/host-fixtures.js";
import { nodeAdapter, nodeAdapterWithReadError } from "../../helpers/node-adapter.js";

describe("Primary Behavior", () => {
  it("flare.json on disk is read and parsed; values appear in host.config after build", async () => {
    const host = new FlareHost(nodeAdapter({
      host: { port: 7777, env: "staging" },
      log: { level: "warn", format: "json" },
    }));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.port).toBe(7777);
      expect(host.config.host?.env).toBe("staging");
      expect(host.config.log?.level).toBe("warn");
      expect(host.config.log?.format).toBe("json");
    } finally {
      await app.stop();
    }
  });

  it("FLARE__HOST__PORT=4000 env override surfaces as host.config.host.port === 4000 (after coercion through the descriptor)", async () => {
    const host = new FlareHost(nodeAdapter(
      {},
      { FLARE_MODE: "test", FLARE__HOST__PORT: "4000" },
    ));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.port).toBe(4000);
      expect(typeof host.config.host?.port).toBe("number");
    } finally {
      await app.stop();
    }
  });

  it("descriptor-level default values appear in host.config when the corresponding section is absent from flare.json", async () => {
    const host = new FlareHost(nodeAdapter({}, { FLARE_MODE: "test" }));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host).toEqual({
        env: "development",
        port: 3000,
        host: "localhost",
        shutdownTimeout: 10000,
        maxBodyBytes: 2 * 1024 * 1024,
        requestIdHeader: true,
        requestTiming: false,
        keepAliveTimeout: 65000,
        headersTimeout: 60000,
        requestTimeout: 300000,
      });
      expect(host.config.log?.level).toBe("info");
      expect(host.config.log?.format).toBe("json");
      expect(host.config.log?.enableContext).toBe(false);
    } finally {
      await app.stop();
    }
  });
});

describe("Edge Cases", () => {
  it("missing flare.json (ENOENT) does not fail the build; defaults + env still apply", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    const adapter = nodeAdapterWithReadError(enoent, {
      FLARE_MODE: "test",
      FLARE__HOST__PORT: "5050",
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.host).toBe("localhost");
      expect(host.config.host?.shutdownTimeout).toBe(10000);
      expect(host.config.host?.port).toBe(5050);
    } finally {
      await app.stop();
    }
  });

  it("lowercase env paths route into the correct camelCase descriptor key (e.g. FLARE__HOST__SHUTDOWNTIMEOUT -> host.shutdownTimeout)", async () => {
    const host = new FlareHost(nodeAdapter(
      {},
      { FLARE_MODE: "test", FLARE__HOST__SHUTDOWNTIMEOUT: "12345" },
    ));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.shutdownTimeout).toBe(12345);
      expect((host.config.host as Record<string, unknown> | undefined)?.["shutdowntimeout"]).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("nested env path with > 2 segments builds nested objects under the section", async () => {
    const host = new FlareHost(nodeAdapter(
      {},
      { FLARE_MODE: "test", FLARE__LOG__TRANSPORTS__CONSOLE__LEVEL: "warn" },
    ));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.log?.transports).toEqual({ console: { level: "warn" } });
    } finally {
      await app.stop();
    }
  });

  it("section omitted from flare.json is auto-inserted as {} so descriptor defaults still fire", async () => {
    const host = new FlareHost(nodeAdapter({ host: { port: 9999, env: "production" } }, { FLARE_MODE: "test" }));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.log).toBeDefined();
      expect(host.config.log?.level).toBe("info");
      expect(host.config.log?.format).toBe("json");
      expect(host.config.log?.enableContext).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('host.env === "development" auto-defaults log.level=debug and log.format=pretty unless explicitly set', async () => {
    {
      const host = new FlareHost(nodeAdapter({ host: { env: "development" } }));
      registerMinimalPingRoute(host);
      const app = await host.build().test();
      try {
        expect(host.config.log?.level).toBe("debug");
        expect(host.config.log?.format).toBe("pretty");
      } finally {
        await app.stop();
      }
    }

    {
      const host = new FlareHost(nodeAdapter({ host: { env: "development" }, log: { level: "error" } }));
      registerMinimalPingRoute(host);
      const app = await host.build().test();
      try {
        expect(host.config.log?.level).toBe("error");
        expect(host.config.log?.format).toBe("pretty");
      } finally {
        await app.stop();
      }
    }

    {
      const host = new FlareHost(nodeAdapter({ host: { env: "development" }, log: { format: "json" } }));
      registerMinimalPingRoute(host);
      const app = await host.build().test();
      try {
        expect(host.config.log?.level).toBe("debug");
        expect(host.config.log?.format).toBe("json");
      } finally {
        await app.stop();
      }
    }

    {
      const host = new FlareHost(nodeAdapter({ host: { env: "production" } }));
      registerMinimalPingRoute(host);
      const app = await host.build().test();
      try {
        expect(host.config.log?.level).toBe("info");
        expect(host.config.log?.format).toBe("json");
      } finally {
        await app.stop();
      }
    }
  });
});

describe("Failure Modes", () => {
  it("env var path containing __proto__, prototype, or constructor is silently rejected (no prototype pollution and no override applied)", async () => {
    const host = new FlareHost(nodeAdapter(
      {},
      {
        FLARE_MODE: "test",
        FLARE__HOST__PROTOTYPE: "pwned",
        FLARE__HOST__CONSTRUCTOR: "pwned",
        FLARE__PROTOTYPE__PORT: "pwned",
        FLARE__CONSTRUCTOR__PORT: "pwned",
        FLARE__HOST__PORT: "1111",
      },
    ));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.port).toBe(1111);
      expect((Object.prototype as Record<string, unknown>)["pwned"]).toBeUndefined();
      const hostSection = host.config.host as unknown as Record<string, unknown>;
      expect(hostSection["prototype"]).toBeUndefined();
      expect(hostSection["constructor"]).not.toBe("pwned");
      const cfg = host.config as Record<string, unknown>;
      expect(cfg["prototype"]).toBeUndefined();
      expect(cfg["constructor"]).not.toBe("pwned");
    } finally {
      await app.stop();
    }
  });

  it("non-ENOENT read errors propagate and abort build", async () => {
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const host = new FlareHost(nodeAdapterWithReadError(eacces));
    expect(() => host.build()).toThrow("EACCES: permission denied");
  });

  it("schema parse failure throws with a JSON-stringified validator error block", async () => {
    const host = new FlareHost(nodeAdapter({ host: { port: "not-a-number" } }));
    expect(() => host.build()).toThrow("Config validation failed");

    let captured: unknown;
    try {
      host.build();
    } catch (err) {
      captured = err;
    }
    const msg = (captured as Error).message;
    const jsonStart = msg.indexOf("{");
    expect(jsonStart).toBeGreaterThan(0);
    const parsedBlock = JSON.parse(msg.slice(jsonStart));
    expect(parsedBlock).toHaveProperty("fields");
    expect(Array.isArray(parsedBlock.fields)).toBe(true);
    expect(parsedBlock.fields.length).toBeGreaterThan(0);
    expect(JSON.stringify(parsedBlock)).toContain("port");
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with host/logger-bootstrap) log config is fully resolved before transports are instantiated, so transports see the final log config", async () => {
    let observedLevel: unknown = "<<unobserved>>";
    let observedFormat: unknown = "<<unobserved>>";
    class ConfigSnoopingTransport extends LoggerTransport {
      static override readonly transportName = "config-snoop";
      static override deps: never[] = [];

      constructor(container: ConstructorParameters<typeof LoggerTransport>[0]) {
        super(container);
        const log = container.resolveCfg(LOG_CONFIG);
        observedLevel = log.level;
        observedFormat = log.format;
      }

      override write(_record: LogRecord): void {}
    }

    const host = new FlareHost(nodeAdapter(
      { log: { level: "error", format: "json" } },
      { FLARE_MODE: "test" },
    ));
    host.logging.transport(ConfigSnoopingTransport);
    registerMinimalPingRoute(host);

    const app = await host.build().test();
    try {
      expect(observedLevel).toBe("error");
      expect(observedFormat).toBe("json");
      expect(host.config.log?.level).toBe("error");
      expect(host.config.log?.format).toBe("json");
    } finally {
      await app.stop();
    }
  });

  it("(with host/composition-root) tokens registered via host.cfg(TOKEN) are included in the resolved config; unregistered token defaults are not", async () => {
    const REGISTERED: ConfigToken<{ url: string; timeout: number; }> = flareConfig("registered", {
      url: str,
      timeout: int,
    });
    const UNREGISTERED: ConfigToken<{ apiKey: string; }> = flareConfig("unregistered", {
      apiKey: str,
    });

    const host = new FlareHost(nodeAdapter({
      registered: { url: "https://example.test", timeout: 5000 },
    }));
    host.cfg(REGISTERED);
    registerMinimalPingRoute(host);

    const app = await host.build().test();
    try {
      const cfg = host.config as Record<string, unknown>;
      expect(cfg[REGISTERED.key]).toEqual({ url: "https://example.test", timeout: 5000 });
      expect(cfg[UNREGISTERED.key]).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});
