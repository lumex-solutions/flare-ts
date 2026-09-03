/**
 * End-to-end Node WebSocket arc upgrade tests for routing, params, subprotocol
 * negotiation, contract validation, and connection tracking. Requires a real
 * http.Server on an ephemeral port and the global WebSocket client.
 */
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { int, schema, str } from "@flare-ts/lib/schema";
import type { FlareWebSocketMessage } from "../../../../../src/lib/arcs/ws/transport/flare-web-socket-message.js";
import type { IFlareHost } from "../../../../../src/lib/host/flare-host.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { WebSocketControllerBase } from "../../../../../src/lib/arcs/ws/composition/classes/controller-base.js";
import { socketContract } from "../../../../../src/lib/arcs/ws/composition/contract/ws-contract.js";
import { handleNodeWsUpgrade } from "../../../../../src/lib/arcs/ws/transport/runtime/node/upgrade.js";
import { COMPILE_WS_ARC, WebSocketArc } from "../../../../../src/lib/arcs/ws/ws-arc.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";

// Node ships a global WebSocket client (stable since 22.4); reach it through globalThis since
// @types/node@20 does not declare it.
const WebSocketClient = (globalThis as unknown as {
  WebSocket: new(url: string, protocols?: string | string[]) => WsClient;
}).WebSocket;
interface WsClient {
  binaryType: string;
  readonly protocol: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Builds a minimal WebSocketArc host for upgrade end-to-end tests. */
function makeHost(): IFlareHost {
  const host = {
    scopedServices: new FlareRegistrationMap(),
    singletonServices: new Map(),
    config: {},
  } as unknown as { ws: WebSocketArc; } & IFlareHost;
  host.ws = new WebSocketArc(host);
  return host;
}

describe("Node WebSocket arc upgrade (end-to-end)", () => {
  let server: Server | undefined;

  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  function serve(host: IFlareHost): Promise<number> {
    host.ws[COMPILE_WS_ARC]();
    server = createServer();
    server.on("upgrade", (req, socket, head) => handleNodeWsUpgrade(host, req, socket, head));
    return new Promise<number>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port))
    );
  }

  it("routes a matched upgrade to its handlers with params and query, then echoes", async () => {
    const host = makeHost();
    let room: string | undefined;
    let x: string | null = null;
    host.ws.route("/chat/:room")
      .open((_ws, scope) => {
        room = scope.input.params.room;
        x = scope.input.query.get("x");
      })
      .message((ws, scope) => ws.send(scope.input.message.raw));
    const port = await serve(host);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/chat/lobby?x=1`);
    await once(ws as unknown as EventTarget, "open");
    expect(room).toBe("lobby");
    expect(x).toBe("1");

    ws.send("hi");
    const [ev] = await once(ws as unknown as EventTarget, "message");
    expect((ev as { data: unknown; }).data).toBe("hi");
    ws.close();
  });

  it("rejects an unmatched upgrade with a 404", async () => {
    const host = makeHost();
    host.ws.route("/chat/:room").close(() => {});
    const port = await serve(host);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/nope`);
    const [ev] = await once(ws as unknown as EventTarget, "error");
    expect(ev).toBeDefined(); // the handshake failed: open never fires
  });

  it("drives a controller registration end-to-end", async () => {
    const host = makeHost();
    const seen: string[] = [];
    class Echo extends WebSocketControllerBase {
      static override deps = [];
      static override state = [];
      override open(): void {
        seen.push(`open:${this.input.params.room}`);
      }
      override message(msg: FlareWebSocketMessage): void {
        this.socket.send(msg.raw);
      }
    }
    host.ws.controller("/room/:room", Echo);
    const port = await serve(host);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/room/42`);
    await once(ws as unknown as EventTarget, "open");
    expect(seen).toEqual(["open:42"]);
    ws.send("ping");
    const [ev] = await once(ws as unknown as EventTarget, "message");
    expect((ev as { data: unknown; }).data).toBe("ping");
    ws.close();
  });

  it("negotiates a per-route subprotocol", async () => {
    const host = makeHost();
    let negotiated: string | undefined;
    host.ws.route("/chat", { subprotocols: ["chat.v1", "chat.v2"] })
      .open((ws) => void (negotiated = ws.protocol))
      .close(() => {});
    const port = await serve(host);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/chat`, ["chat.v9", "chat.v2"]);
    await once(ws as unknown as EventTarget, "open");
    expect(negotiated).toBe("chat.v2"); // first client-offered token the server also accepts
    expect(ws.protocol).toBe("chat.v2");
    ws.close();
  });

  it("returns the live connection so it can be tracked and closed (graceful shutdown)", async () => {
    const host = makeHost();
    host.ws.route("/chat").close(() => {});
    host.ws[COMPILE_WS_ARC]();

    // Mirror FlareAppNode.#wireWebSocketUpgrade: track the returned connection, deregister on close.
    const tracked = new Set<unknown>();
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      const conn = handleNodeWsUpgrade(host, req, socket, head);
      if (conn) {
        tracked.add(conn);
        socket.on("close", () => tracked.delete(conn));
      }
    });
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port))
    );

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/chat`);
    await once(ws as unknown as EventTarget, "open");
    expect(tracked.size).toBe(1); // the connection was returned and tracked

    const closed = once(ws as unknown as EventTarget, "close");
    for (const conn of tracked) {
      (conn as { close(code: number, reason: string): void; }).close(1001, "Server shutting down");
    }
    const [ev] = await closed;
    expect((ev as { code: number; }).code).toBe(1001); // the shutdown close reaches the client
  });

  it("validates + types a message contract end-to-end (function form)", async () => {
    const ChatSchema = schema({ type: str, text: str });
    const host = makeHost();
    host.ws.route("/chat", { incoming: ChatSchema, outgoing: ChatSchema })
      .message((ws, scope) => ws.send({ type: "echo", text: scope.input.message.text })) // message typed { type, text }
      .close(() => {});
    const port = await serve(host);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/chat`);
    await once(ws as unknown as EventTarget, "open");
    ws.send(JSON.stringify({ type: "chat", text: "hi" }));
    const [ev] = await once(ws as unknown as EventTarget, "message");
    expect(JSON.parse((ev as { data: string; }).data)).toEqual({ type: "echo", text: "hi" });
    ws.close();
  });

  it("validates + types a message contract for the controller form", async () => {
    const ChatSchema = schema({ type: str, text: str });
    const Chat = socketContract({ chat: { incoming: ChatSchema, outgoing: ChatSchema } });
    const host = makeHost();
    class Echo extends WebSocketControllerBase<typeof Chat.chat> {
      static override deps = [];
      static override state = [];
      static override contract = Chat.chat;
      override message(m: { type: string; text: string; }): void {
        this.socket.send({ type: "echo", text: m.text });
      }
      override close(): void {}
    }
    host.ws.controller("/chat", Echo);
    const port = await serve(host);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/chat`);
    await once(ws as unknown as EventTarget, "open");
    ws.send(JSON.stringify({ type: "chat", text: "yo" }));
    const [ev] = await once(ws as unknown as EventTarget, "message");
    expect(JSON.parse((ev as { data: string; }).data)).toEqual({ type: "echo", text: "yo" });
    ws.close();
  });

  it("rejects (does NOT crash) when a required typed param fails parsing", async () => {
    const host = makeHost();
    host.ws.route("/typed", { query: { n: int } })
      .message((ws, scope) => ws.send(String(scope.input.query.n)))
      .close(() => {});
    const port = await serve(host);

    // Connect without ?n=; int("") throws in parsing. Must reject the upgrade, never take the process
    // down: an uncaught throw out of the 'upgrade' listener would otherwise crash the whole server on
    // a single bad request (remote DoS).
    const bad = new WebSocketClient(`ws://127.0.0.1:${port}/typed`);
    const [ev] = await once(bad as unknown as EventTarget, "error");
    expect(ev).toBeDefined(); // handshake failed, no open

    // Proof the server survived: a valid connection to the same route still works.
    const good = new WebSocketClient(`ws://127.0.0.1:${port}/typed?n=42`);
    await once(good as unknown as EventTarget, "open");
    good.send("go");
    const [msg] = await once(good as unknown as EventTarget, "message");
    expect((msg as { data: unknown; }).data).toBe("42");
    good.close();
  });

  it("denies the handshake with the upgrade hook's HTTP response (async hook, real 401 bytes)", async () => {
    const host = makeHost();
    let opened = false;
    host.ws.route("/gated")
      .upgrade(async (upgrade) => {
        if (upgrade.header("x-token") !== "secret") return new FlareResponse(401, { error: "nope" });
      })
      .open(() => void (opened = true));
    const port = await serve(host);

    // Drive the upgrade with a raw HTTP client so the denial's status and body are observable (the
    // WebSocket client only surfaces an opaque error). The server's 'upgrade' event still fires.
    const res = await new Promise<{ status: number | undefined; body: string; }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/gated",
        headers: {
          "Connection": "Upgrade",
          "Upgrade": "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("response", (r) => {
        let body = "";
        r.on("data", (chunk: Buffer) => (body += chunk.toString()));
        r.on("end", () => resolve({ status: r.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "nope" });
    expect(opened).toBe(false);
  });

  // The client-observable hook behaviors (accept with hook-provided state, accept-then-close code +
  // reason) are pinned by the shared parity matrix (portable/parity), which this backing runs in
  // parity.test.ts; only the HTTP-observable denial above needs this suite's raw client.

  it("decodes a percent-encoded path param", async () => {
    const host = makeHost();
    let room: string | undefined;
    host.ws.route("/chat/:room")
      .open((_ws, scope) => void (room = scope.input.params.room))
      .close(() => {});
    const port = await serve(host);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/chat/a%20b`);
    await once(ws as unknown as EventTarget, "open");
    expect(room).toBe("a b");
    ws.close();
  });
});
