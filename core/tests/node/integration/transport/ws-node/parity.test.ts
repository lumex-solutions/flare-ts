/**
 * Node WebSocket backing-parity tests: runs the shared parity scenarios against the
 * Node transport through a real HTTP server and global WebSocket client.
 */
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, describe, it } from "vitest";
import type { IFlareHost } from "../../../../../src/lib/host/flare-host.js";
import type { Connect } from "../../../../portable/parity/scenarios.js";
import { handleNodeWsUpgrade } from "../../../../../src/lib/arcs/ws/transport/runtime/node/upgrade.js";
import { COMPILE_WS_ARC, WebSocketArc } from "../../../../../src/lib/arcs/ws/ws-arc.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";
import { registerParityRoutes } from "../../../../portable/parity/routes.js";
import { makeParityClient, parityScenarios } from "../../../../portable/parity/scenarios.js";

// Node ships a global WebSocket client (stable since 22.4); reach it through globalThis since
// @types/node@20 does not declare it.
const WebSocketClient = (globalThis as unknown as {
  WebSocket: new(url: string, protocols?: readonly string[]) => NodeWsClient;
}).WebSocket;
interface NodeWsClient {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

function makeHost(): IFlareHost {
  const host = {
    scopedServices: new FlareRegistrationMap(),
    singletonServices: new Map(),
    config: {},
  } as unknown as { ws: WebSocketArc; } & IFlareHost;
  host.ws = new WebSocketArc(host);
  return host;
}

const host = makeHost();
registerParityRoutes(host.ws);
host.ws[COMPILE_WS_ARC]();

const server: Server = createServer();
server.on("upgrade", (req, socket, head) => handleNodeWsUpgrade(host, req, socket, head));
const port = new Promise<number>((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
);
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const connect: Connect = async (path, protocols) => {
  const ws = new WebSocketClient(`ws://127.0.0.1:${await port}${path}`, protocols);
  ws.binaryType = "arraybuffer";
  const { client, pushFrame, pushClose } = makeParityClient(
    (data) => ws.send(data),
    (code, reason) => ws.close(code, reason),
  );
  ws.addEventListener(
    "message",
    ((e: { data: string | ArrayBuffer; }) => {
      pushFrame(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    }) as never,
  );
  ws.addEventListener("close", ((e: { code: number; reason: string; }) => pushClose(e.code, e.reason)) as never);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", (() => resolve()) as never);
    ws.addEventListener("error", (() => reject(new Error(`handshake failed for ${path}`))) as never);
  });
  return client;
};

describe("WS backing parity: node", () => {
  for (const scenario of parityScenarios) {
    it(scenario.name, () => scenario.run(connect, { crossConnectionChannels: true }));
  }
});
