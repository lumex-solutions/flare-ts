/**
 * The parity scenario matrix: client-driven assertions over the routes in `routes.ts`, written once
 * and executed against every backing (Node server, plain Worker, Durable Object resident, Durable
 * Object hibernating). Each pool's test file supplies only a {@link Connect} adapter; the scenario
 * bodies - including every expectation - are shared, so the four backings are held to byte-identical
 * observable behavior.
 */
import { expect } from "vitest";

/** Client view of one connection: normalized frames plus the terminal close. */
export interface ParityClient {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Resolves the next inbound frame (text as string, binary as Uint8Array). */
  nextFrame(): Promise<string | Uint8Array>;
  /** Resolves once the connection closes, with the observed close code/reason. */
  closed: Promise<{ code: number; reason: string; }>;
}

/**
 * Opens one connection to a parity route. `path` is relative to the backing's parity root; the
 * adapter owns the URL shape (port, mount prefix, instance name). Rejects when the handshake is
 * refused (non-101 / socket error before open).
 */
export type Connect = (path: string, protocols?: readonly string[]) => Promise<ParityClient>;

/**
 * Declared capabilities of a backing. Divergences between backings are ENCODED here, never silent:
 * a scenario that branches on a capability asserts the loud, documented failure contract on
 * backings without it, so the matrix still pins exact behavior everywhere.
 */
export interface ParityCaps {
  /**
   * Whether this backing has a broadcast domain (channels). False only on a plain Cloudflare Worker:
   * workerd pins each WebSocket to the request that accepted it, so cross-connection delivery is
   * cross-request I/O the runtime rejects. The Worker context's channel backend therefore fails the
   * connection at the earliest moment - `ws.subscribe` throws with the actionable fix, so a channel
   * route closes 1011 at open. Durable Objects exist to own a shared context; Node shares the process.
   */
  readonly crossConnectionChannels: boolean;
  /**
   * Whether this backing supports the pre-handshake `upgrade` hook. False on both Durable Object
   * legs: a hook on a DO WS route is a build error (the mount's `resolve` handler is the DO's gate),
   * so routes.ts registers the hook routes only where this is true and the scenario arms assert the
   * unmatched-path contract on the legs without them.
   */
  readonly upgradeHook: boolean;
}

/** One matrix entry: a named, self-asserting scenario run against a backing's {@link Connect}. */
export interface ParityScenario {
  readonly name: string;
  run(connect: Connect, caps: ParityCaps): Promise<void>;
}

const FRAME_TIMEOUT_MS = 8000;

/**
 * Builds a {@link ParityClient} from adapter callbacks: the adapter wires transport events into
 * `pushFrame`/`pushClose`, both pools share the queueing, timeout, and normalization.
 */
export function makeParityClient(
  send: (data: string | Uint8Array) => void,
  close: (code?: number, reason?: string) => void,
): {
  client: ParityClient;
  pushFrame(data: string | Uint8Array): void;
  pushClose(code: number, reason: string): void;
} {
  const frames: Array<string | Uint8Array> = [];
  const waiters: Array<(f: string | Uint8Array) => void> = [];
  let resolveClosed!: (c: { code: number; reason: string; }) => void;
  const closed = new Promise<{ code: number; reason: string; }>((r) => (resolveClosed = r));

  return {
    client: {
      send,
      close,
      nextFrame() {
        const queued = frames.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), FRAME_TIMEOUT_MS);
          waiters.push((f) => {
            clearTimeout(timer);
            resolve(f);
          });
        });
      },
      closed,
    },
    pushFrame(data) {
      const waiter = waiters.shift();
      if (waiter) waiter(data);
      else frames.push(data);
    },
    pushClose(code, reason) {
      resolveClosed({ code, reason });
    },
  };
}

/** Opens `n` connections to `path`, runs `fn`, and closes whatever is still open afterward. */
async function withClients(
  connect: Connect,
  path: string,
  n: number,
  fn: (...clients: ParityClient[]) => Promise<void>,
): Promise<void> {
  const clients: ParityClient[] = [];
  for (let i = 0; i < n; i++) clients.push(await connect(path));
  try {
    await fn(...clients);
  } finally {
    for (const c of clients) c.close();
  }
}

/** Shared parity scenario matrix run against each backing's Connect adapter. */
export const parityScenarios: readonly ParityScenario[] = [
  {
    name: "echoes a text message",
    run: (connect) =>
      withClients(connect, "/echo", 1, async (c) => {
        c.send("hello parity");
        expect(await c.nextFrame()).toBe("hello parity");
      }),
  },
  {
    name: "echoes a binary message byte-for-byte",
    run: (connect) =>
      withClients(connect, "/echo", 1, async (c) => {
        c.send(new Uint8Array([0, 1, 127, 128, 250]));
        const frame = await c.nextFrame();
        expect(frame).toBeInstanceOf(Uint8Array);
        expect([...(frame as Uint8Array)]).toEqual([0, 1, 127, 128, 250]);
      }),
  },
  {
    name: "echoes a 64 KiB text message intact",
    run: (connect) =>
      withClients(connect, "/echo", 1, async (c) => {
        const big = "x".repeat(64 * 1024);
        c.send(big);
        expect(await c.nextFrame()).toBe(big);
      }),
  },
  {
    name: "parses typed params and query, validates incoming messages (1008 on invalid)",
    run: async (connect) => {
      const c = await connect("/typed/7?x=3");
      expect(await c.nextFrame()).toBe("in:7:3");
      c.send(JSON.stringify({ v: "ok" }));
      expect(await c.nextFrame()).toBe("v:ok");
      c.send("not json");
      expect((await c.closed).code).toBe(1008);
    },
  },
  {
    name: "carries ws.state across messages",
    run: (connect) =>
      withClients(connect, "/state", 1, async (c) => {
        for (const n of [1, 2, 3]) {
          c.send("bump");
          expect(await c.nextFrame()).toBe(`hits:${n}`);
        }
      }),
  },
  {
    name: "publishes to channel subscribers, excluding the publisher by default",
    run: async (connect, caps) => {
      if (!caps.crossConnectionChannels) {
        // Declared divergence: no broadcast domain here, and the contract is a LOUD failure at the
        // earliest moment - the route's subscribe-at-open throws the actionable error, closing 1011.
        const c = await connect("/chat");
        expect((await c.closed).code).toBe(1011);
        return;
      }
      await withClients(connect, "/chat", 2, async (a, b) => {
        a.send("pub:hello");
        expect(await b.nextFrame()).toBe("msg:hello");
        a.send("pubself:solo");
        expect(await a.nextFrame()).toBe("msg:solo"); // self included on request; the default excluded it above
        expect(await b.nextFrame()).toBe("msg:solo");
      });
    },
  },
  {
    name: "unsubscribe stops channel delivery",
    run: async (connect, caps) => {
      if (!caps.crossConnectionChannels) {
        // Declared divergence: the /chat route subscribes at open, which fails 1011 here (see above).
        const c = await connect("/chat");
        expect((await c.closed).code).toBe(1011);
        return;
      }
      await withClients(connect, "/chat", 2, async (a, b) => {
        b.send("unsub");
        expect(await b.nextFrame()).toBe("unsubbed");
        a.send("pubself:after");
        expect(await a.nextFrame()).toBe("msg:after");
        b.send("ping");
        expect(await b.nextFrame()).toBe("pong"); // the direct probe arrives first: no channel frame reached b
      });
    },
  },
  {
    name: "close handler observes code, reason, and wasClean (witnessed via a channel)",
    run: async (connect, caps) => {
      if (!caps.crossConnectionChannels) {
        // Declared divergence: the witness route subscribes at open, which fails 1011 here (see the
        // capability doc); there is no channel to witness through.
        const c = await connect("/close-witness");
        expect((await c.closed).code).toBe(1011);
        return;
      }
      await withClients(connect, "/close-witness", 1, async (witness) => {
        witness.send("ping");
        expect(await witness.nextFrame()).toBe("pong");
        const closer = await connect("/close-witness");
        closer.send("ping");
        expect(await closer.nextFrame()).toBe("pong"); // the closer is fully open before it closes
        closer.close(4001, "bye");
        expect(await witness.nextFrame()).toBe("closed:4001:bye:true");
      });
    },
  },
  {
    name: "closes 1011 when the open handler throws",
    run: async (connect) => {
      const c = await connect("/open-throw");
      expect((await c.closed).code).toBe(1011);
    },
  },
  {
    name: "closes 1011 when the controller constructor throws",
    run: async (connect) => {
      const c = await connect("/ctor-throw");
      expect((await c.closed).code).toBe(1011);
    },
  },
  {
    name: "runs the route error handler, then closes 1011, when the message handler throws",
    run: async (connect) => {
      const c = await connect("/msg-throw");
      c.send("x");
      expect(await c.nextFrame()).toBe("err:msg boom");
      expect((await c.closed).code).toBe(1011);
    },
  },
  {
    name: "negotiates a subprotocol the client offered",
    run: async (connect) => {
      const c = await connect("/proto", ["chat.v2"]);
      expect(await c.nextFrame()).toBe("proto:chat.v2");
      c.close();
    },
  },
  {
    name: "drives the controller form: greeting at open, echo per message",
    run: (connect) =>
      withClients(connect, "/ctrl", 1, async (c) => {
        expect(await c.nextFrame()).toBe("ctrl-hello");
        c.send("via-controller");
        expect(await c.nextFrame()).toBe("via-controller");
      }),
  },
  {
    name: "rejects an upgrade to an unmatched path",
    run: async (connect) => {
      await expect(connect("/nope")).rejects.toThrow();
    },
  },
  {
    name: "upgrade hook: denies without a ticket, accepts with hook-provided state visible at open",
    run: async (connect, caps) => {
      if (!caps.upgradeHook) {
        // Declared divergence: the hook is front-door-only (a DO WS route with one is a build error),
        // so the gate route does not exist on this backing and the path is an unmatched upgrade.
        await expect(connect("/gated?ticket=t1")).rejects.toThrow();
        return;
      }
      await expect(connect("/gated")).rejects.toThrow(); // refused before open: no ticket
      const c = await connect("/gated?ticket=t1");
      expect(await c.nextFrame()).toBe("gate:user:t1");
      c.close();
    },
  },
  {
    name: "upgrade hook: an accept-then-close refusal's code and reason reach the client",
    run: async (connect, caps) => {
      if (!caps.upgradeHook) {
        // Same declared divergence as the gate scenario: the route exists only where hooks do.
        await expect(connect("/moved")).rejects.toThrow();
        return;
      }
      const c = await connect("/moved");
      expect(await c.closed).toEqual({ code: 4302, reason: "/relocated" });
    },
  },
];
