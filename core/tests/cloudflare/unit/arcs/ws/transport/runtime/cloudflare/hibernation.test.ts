/**
 * White-box tests for the Durable Object hibernation engine. Real bindings never evict mid-test, so
 * these force the scenario hibernation actually exercises: a later event reconstructs the connection from
 * ONLY the socket attachment, sharing no memory with the accept. State + channel membership must survive
 * that boundary. Runs in the workerd pool (the engine's types are workers-typed, and workerd is the
 * representative runtime).
 */
import { describe, expect, it, vi } from "vitest";
import { schema, str } from "@flare-ts/lib/schema";
import type { WebSocketDescriptor } from "../../../../../../../../src/lib/arcs/ws/composition/contract/ws-contract.js";
import type {
  WsHandlerFns,
  WebSocketChannelSelector,
  WsRegistration,
} from "../../../../../../../../src/lib/arcs/ws/composition/types/registration.js";
import type { WsRawInput } from "../../../../../../../../src/lib/arcs/ws/pipeline/input.js";
import type { WsPipeline } from "../../../../../../../../src/lib/arcs/ws/pipeline/route.js";
import type {
  FlareWebSocketContext,
  WebSocketState,
} from "../../../../../../../../src/lib/arcs/ws/transport/flare-web-socket-context.js";
import type { WsAttachment } from "../../../../../../../../src/lib/arcs/ws/transport/runtime/cloudflare/types.js";
import type { WsAcceptOptions } from "../../../../../../../../src/lib/arcs/ws/transport/socket.js";
import type { StateToken, TypedStateToken } from "../../../../../../../../src/lib/state/types/state-token.js";
import { flareState } from "../../../../../../../../src/index.js";
import { compileWsRoutes } from "../../../../../../../../src/lib/arcs/ws/pipeline/build.js";
import { readAttachment } from "../../../../../../../../src/lib/arcs/ws/transport/runtime/cloudflare/attachment.js";
import { HibernationChannelIndex } from "../../../../../../../../src/lib/arcs/ws/transport/runtime/cloudflare/hibernation-channel-index.js";
import {
  deliverHibernated,
  openHibernatable,
} from "../../../../../../../../src/lib/arcs/ws/transport/runtime/cloudflare/hibernation.js";
import { Container } from "../../../../../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../../../../../src/lib/services/registration-map.js";

/** Fake hibernatable native socket: records sends/close, holds a structured-clone-round-tripped attachment. */
class FakeNative {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  closed: { code?: number | undefined; reason?: string | undefined; } | undefined;
  #attachment: unknown = null;
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data as string | Uint8Array);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  // Structured-clone on both ends, mirroring workerd: the attachment is a snapshot, never a live reference.
  serializeAttachment(value: unknown): void {
    this.#attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return this.#attachment === null ? null : structuredClone(this.#attachment);
  }
}

/** The engine consumes native workerd sockets; the fake stands in behind this one cast. */
const asWs = (f: FakeNative) => f as unknown as WebSocket;

/** Fresh channel index (empty, like a DO instance before any socket has subscribed). */
function freshIndex(): HibernationChannelIndex {
  return new HibernationChannelIndex();
}

function makeContainer(): Container {
  return new Container(new FlareRegistrationMap(), new Map(), {});
}

const RAW: WsRawInput = { params: { room: "lobby" }, query: new URLSearchParams("x=1") };
/** The resolved default accept options (the same derivation a config-less host build produces). */
const ACCEPT: WsAcceptOptions = compileWsRoutes([], undefined).acceptOptions;

/** Builds a raw function-form registration and runs it through the REAL compile step (route index 0). */
function reg(
  behaviors: Partial<Record<"open" | "message" | "close" | "error", (...args: never[]) => void | Promise<void>>>,
  opts?: { descriptor?: WebSocketDescriptor; state?: readonly StateToken[]; channel?: WebSocketChannelSelector; },
): WsPipeline {
  const registration: WsRegistration = {
    kind: "handlers",
    pattern: "/test",
    subprotocols: [],
    descriptor: opts?.descriptor,
    inject: {},
    state: opts?.state ?? [],
    channel: opts?.channel,
    hibernate: true,
    behaviors: behaviors as WsHandlerFns,
  };
  return compileWsRoutes([registration], undefined).pipelines[0]!;
}

/** Re-reads a socket's attachment the way the arc's driver entry does. */
function attachmentOf(socket: FakeNative): WsAttachment {
  const a = readAttachment(asWs(socket));
  if (!a) throw new Error("expected a flare attachment");
  return a;
}

describe("hibernation engine", () => {
  it("serializes route input, state, and channels into the attachment at accept", async () => {
    const User = flareState<{ name: string; }>("User");
    const socket = new FakeNative();
    await openHibernatable({
      pipeline: reg({
        open: (ws: FlareWebSocketContext<string> & { state: WebSocketState; }) => {
          ws.state.set(User as TypedStateToken<{ name: string; }>, { name: "alice" });
          ws.subscribe("room");
          ws.send("welcome");
        },
      }, { state: [User] }),

      raw: RAW,
      container: makeContainer(),
      socket: asWs(socket),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      id: "conn-1",
      protocol: "chat.v1",
    });

    expect(socket.sent).toEqual(["welcome"]); // open ran once
    const att = attachmentOf(socket);
    expect(att.r).toBe(0); // pipeline.index (the reg() helper compiles one route: index 0)
    expect(att.id).toBe("conn-1");
    expect(att.proto).toBe("chat.v1");
    expect(att.p).toEqual({ room: "lobby" });
    expect(att.c).toEqual(["room"]);
    expect(att.s).toEqual([{ name: "alice" }]); // state bag aligned to the declared token
  });

  it("survives a wake: a later message reads state set at open, over a socket sharing no memory", async () => {
    const User = flareState<{ name: string; }>("User");
    const pipeline = reg({
      open: (ws: FlareWebSocketContext<string> & { state: WebSocketState; }) =>
        ws.state.set(User as TypedStateToken<{ name: string; }>, { name: "alice" }),
      message: (ws: FlareWebSocketContext<string> & { state: WebSocketState; }) => {
        const user = ws.state.get(User as TypedStateToken<{ name: string; }>);
        ws.send(`hi:${user?.name ?? "?"}`);
      },
    }, { state: [User] });

    // Accept on one socket, then "wake" on a brand-new socket seeded ONLY with the serialized attachment.
    const accepting = new FakeNative();
    await openHibernatable({
      pipeline,
      raw: RAW,
      container: makeContainer(),
      socket: asWs(accepting),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      id: "c",
      protocol: "",
    });
    const woken = new FakeNative();
    woken.serializeAttachment(attachmentOf(accepting)); // the only thing that crossed the wake

    const att = attachmentOf(woken);
    await deliverHibernated({
      pipeline,
      raw: { params: att.p, query: new URLSearchParams(att.q) },
      // A fresh instance on wake rebuilds its index from the live sockets' attachments.
      container: makeContainer(),
      socket: asWs(woken),
      index: HibernationChannelIndex.seed([asWs(woken)]),
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: att,
      event: { kind: "message", data: "ping" },
    });

    expect(woken.sent).toEqual(["hi:alice"]); // state survived purely via the attachment
  });

  it("contains a throwing controller constructor on a wake: close 1011 + dispose, no escape", async () => {
    // Under hibernation the controller is constructed PER EVENT, so a throwing constructor is a wake-path
    // failure. It must get the handler-failure policy (logged, 1011, container disposed), never escape
    // through webSocketMessage as an uncaught exception.
    class Boom {
      constructor() {
        throw new Error("ctor boom");
      }
    }
    const registration: WsRegistration = {
      kind: "controller",
      pattern: "/test",
      subprotocols: [],
      descriptor: undefined,
      inject: {},
      state: [],
      channel: undefined,
      hibernate: true,
      cls: Boom as never,
    };
    const pipeline = compileWsRoutes([registration], undefined).pipelines[0]!;
    const socket = new FakeNative();
    socket.serializeAttachment({ r: 0, id: "c1", proto: "", p: {}, q: "", c: [], s: [] });
    const container = makeContainer();
    const dispose = vi.spyOn(container, "dispose");

    const att = attachmentOf(socket);
    await deliverHibernated({
      pipeline,
      raw: { params: att.p, query: new URLSearchParams(att.q) },
      container,
      socket: asWs(socket),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: att,
      event: { kind: "message", data: "hi" },
    });

    expect(socket.closed).toEqual({ code: 1011, reason: "Connection reconstruction failed" });
    expect(dispose).toHaveBeenCalled();
  });

  it("publishes to channel subscribers across the DO via getWebSockets, honoring exclude-self", async () => {
    const pipeline = reg({
      open: (ws: FlareWebSocketContext<string>) => ws.subscribe("room"),
      message: (ws: FlareWebSocketContext<string>) => ws.publish("room", "broadcast"), // default: exclude self
    });
    const a = new FakeNative();
    const b = new FakeNative();
    // One index shared across the two accepts + the delivery, as a single DO instance would have.
    const index = freshIndex();
    for (const socket of [a, b]) {
      await openHibernatable({
        pipeline,
        raw: RAW,
        container: makeContainer(),
        socket: asWs(socket),
        index,
        acceptOptions: ACCEPT,
        logContext: undefined,
        id: "x",
        protocol: "",
      });
    }
    a.sent.length = 0;
    b.sent.length = 0;

    const att = attachmentOf(a);
    await deliverHibernated({
      pipeline,
      raw: { params: att.p, query: new URLSearchParams(att.q) },
      container: makeContainer(),
      socket: asWs(a),
      index,
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: att,
      event: { kind: "message", data: "go" },
    });

    expect(a.sent).toEqual([]); // publisher excluded itself
    expect(b.sent).toEqual(["broadcast"]); // the other subscriber received it
  });

  it("rebuilds the channel index from attachments on a wake, so publish still reaches subscribers", async () => {
    const pipeline = reg({
      open: (ws: FlareWebSocketContext<string>) => ws.subscribe("room"),
      message: (ws: FlareWebSocketContext<string>) => ws.publish("room", "after-wake"),
    });
    // Accept two connections under one instance, then evict: the index is gone, only attachments remain.
    const a = new FakeNative();
    const b = new FakeNative();
    const before = freshIndex();
    for (const socket of [a, b]) {
      await openHibernatable({
        pipeline,
        raw: RAW,
        container: makeContainer(),
        socket: asWs(socket),
        index: before,
        acceptOptions: ACCEPT,
        logContext: undefined,
        id: "x",
        protocol: "",
      });
    }
    a.sent.length = 0;
    b.sent.length = 0;

    // Wake: a brand-new index seeded ONLY from the sockets' attachments (what the arc does on first event).
    const rebuilt = HibernationChannelIndex.seed([asWs(a), asWs(b)]);
    const att = attachmentOf(a);
    await deliverHibernated({
      pipeline,
      raw: { params: att.p, query: new URLSearchParams(att.q) },
      container: makeContainer(),
      socket: asWs(a),
      index: rebuilt,
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: att,
      event: { kind: "message", data: "go" },
    });

    expect(b.sent).toEqual(["after-wake"]); // membership was reconstructed from b's attachment, not memory
  });

  it("drops a connection from the index on close, so a later publish does not reach it", async () => {
    const pipeline = reg({
      open: (ws: FlareWebSocketContext<string>) => ws.subscribe("room"),
      message: (ws: FlareWebSocketContext<string>) => ws.publish("room", "hello", { self: true }),
      close: () => {},
    });
    const a = new FakeNative();
    const b = new FakeNative();
    const index = freshIndex();
    for (const socket of [a, b]) {
      await openHibernatable({
        pipeline,
        raw: RAW,
        container: makeContainer(),
        socket: asWs(socket),
        index,
        acceptOptions: ACCEPT,
        logContext: undefined,
        id: "x",
        protocol: "",
      });
    }
    // b closes, so it must leave the index.
    const bAtt = attachmentOf(b);
    await deliverHibernated({
      pipeline,
      raw: { params: bAtt.p, query: new URLSearchParams(bAtt.q) },
      container: makeContainer(),
      socket: asWs(b),
      index,
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: bAtt,
      event: { kind: "close", code: 1000, reason: "", wasClean: true },
    });
    a.sent.length = 0;
    b.sent.length = 0;

    // a publishes to the room (including self): only a receives it; b was removed on close.
    const aAtt = attachmentOf(a);
    await deliverHibernated({
      pipeline,
      raw: { params: aAtt.p, query: new URLSearchParams(aAtt.q) },
      container: makeContainer(),
      socket: asWs(a),
      index,
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: aAtt,
      event: { kind: "message", data: "go" },
    });

    expect(a.sent).toEqual(["hello"]); // self, included
    expect(b.sent).toEqual([]); // gone from the index after close
  });

  it("closes 1008 on a message that fails contract validation", async () => {
    const descriptor: WebSocketDescriptor = { incoming: schema({ type: str }) };
    const pipeline = reg({ message: (ws: FlareWebSocketContext<string>) => ws.send("should-not-run") }, { descriptor });
    const socket = new FakeNative();
    await openHibernatable({
      pipeline,
      raw: RAW,
      container: makeContainer(),
      socket: asWs(socket),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      id: "c",
      protocol: "",
    });

    const att = attachmentOf(socket);
    await deliverHibernated({
      pipeline,
      raw: { params: att.p, query: new URLSearchParams(att.q) },
      container: makeContainer(),
      socket: asWs(socket),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: att,
      event: { kind: "message", data: "{}" }, // missing `type`
    });

    expect(socket.closed?.code).toBe(1008);
    expect(socket.sent).toEqual([]); // handler never ran
  });

  it("disposes the per-event container on close", async () => {
    const pipeline = reg({ close: () => {} });
    const socket = new FakeNative();
    await openHibernatable({
      pipeline,
      raw: RAW,
      container: makeContainer(),
      socket: asWs(socket),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      id: "c",
      protocol: "",
    });
    const container = makeContainer();
    const dispose = vi.spyOn(container, "dispose");

    const att = attachmentOf(socket);
    await deliverHibernated({
      pipeline,
      raw: { params: att.p, query: new URLSearchParams(att.q) },
      container,
      socket: asWs(socket),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      attachment: att,
      event: { kind: "close", code: 1000, reason: "bye", wasClean: true },
    });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes 1011 (not throw) when a socket rejects the attachment (over the 16 KB budget)", async () => {
    const socket = new FakeNative();
    // Simulate workerd rejecting an over-budget attachment: serialize throws.
    socket.serializeAttachment = () => {
      throw new Error("attachment too large");
    };
    await openHibernatable({
      pipeline: reg({ open: () => {} }),
      raw: RAW,
      container: makeContainer(),
      socket: asWs(socket),
      index: freshIndex(),
      acceptOptions: ACCEPT,
      logContext: undefined,
      id: "c",
      protocol: "",
    });
    expect(socket.closed?.code).toBe(1011); // surfaced as a connection-setup failure, never an uncaught throw
  });
});
