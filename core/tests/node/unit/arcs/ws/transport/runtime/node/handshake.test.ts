/**
 * Unit tests for computeAcceptKey and performHandshake against RFC 6455 examples
 * and invalid upgrade requests.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  computeAcceptKey,
  performHandshake,
} from "../../../../../../../../src/lib/arcs/ws/transport/runtime/node/handshake.js";

describe("computeAcceptKey", () => {
  it("matches the RFC 6455 worked example", () => {
    // RFC 6455 section 1.3: key "dGhlIHNhbXBsZSBub25jZQ==" produces "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".
    expect(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("is deterministic and key-dependent", () => {
    expect(computeAcceptKey("x3JJHMbDL1EzLkh9GBhXDw==")).toBe(computeAcceptKey("x3JJHMbDL1EzLkh9GBhXDw=="));
    expect(computeAcceptKey("x3JJHMbDL1EzLkh9GBhXDw==")).not.toBe(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="));
  });
});

const VALID_HEADERS = {
  "upgrade": "websocket",
  "connection": "Upgrade",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
} as const;

function fakeReq(headers: Record<string, string>, method = "GET"): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

function fakeSocket() {
  const chunks: string[] = [];
  const state = { destroyed: false };
  const socket = {
    write(s: string) {
      chunks.push(s);
      return true;
    },
    destroy() {
      state.destroyed = true;
    },
  } as unknown as Duplex;
  return { socket, written: () => chunks.join(""), state };
}

describe("performHandshake", () => {
  it("accepts a valid upgrade and writes a 101 with the computed accept key", () => {
    const sock = fakeSocket();
    const result = performHandshake(fakeReq({ ...VALID_HEADERS }), sock.socket, []);
    expect(result).toEqual({ protocol: "" });
    const out = sock.written();
    expect(out).toContain("101 Switching Protocols");
    expect(out).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(out.endsWith("\r\n\r\n")).toBe(true);
  });

  it("picks the first accepted subprotocol the client offers and echoes it", () => {
    const sock = fakeSocket();
    const result = performHandshake(
      fakeReq({ ...VALID_HEADERS, "sec-websocket-protocol": "chat.v3, chat.v1" }),
      sock.socket,
      ["chat.v1", "chat.v2"],
    );
    expect(result).toEqual({ protocol: "chat.v1" });
    expect(sock.written()).toContain("Sec-WebSocket-Protocol: chat.v1");
  });

  it("selects no subprotocol when none of the offered ones are accepted", () => {
    const sock = fakeSocket();
    const result = performHandshake(
      fakeReq({ ...VALID_HEADERS, "sec-websocket-protocol": "mqtt" }),
      sock.socket,
      ["chat.v1"],
    );
    expect(result).toEqual({ protocol: "" });
    expect(sock.written()).not.toContain("Sec-WebSocket-Protocol");
  });

  it("never echoes a CRLF-laden offered subprotocol (no response-header injection)", () => {
    const sock = fakeSocket();
    const result = performHandshake(
      fakeReq({ ...VALID_HEADERS, "sec-websocket-protocol": "chat\r\nX-Injected: 1" }),
      sock.socket,
      ["chat.v1"],
    );
    expect(result).toEqual({ protocol: "" });
    expect(sock.written()).not.toContain("X-Injected");
  });

  it("ignores an oversized offered subprotocol list", () => {
    const many = Array.from({ length: 100 }, (_, i) => `p${i}`).join(",");
    const sock = fakeSocket();
    const result = performHandshake(
      fakeReq({ ...VALID_HEADERS, "sec-websocket-protocol": many }),
      sock.socket,
      ["p50"],
    );
    expect(result).toEqual({ protocol: "" }); // more than the token cap yields no pick
  });

  it.each([
    ["a non-GET method", () => performHandshakeWith({ ...VALID_HEADERS }, "POST")],
    ["a missing Upgrade header", () => performHandshakeWith({ ...VALID_HEADERS, upgrade: "" })],
    ["the wrong version", () => performHandshakeWith({ ...VALID_HEADERS, "sec-websocket-version": "8" })],
    ["a missing key", () => performHandshakeWith(omitKey({ ...VALID_HEADERS }))],
  ])("rejects %s with a 400 and destroys the socket", (_label, run) => {
    const { result, written, destroyed } = run();
    expect(result).toBeNull();
    expect(written).toContain("400 Bad Request");
    expect(destroyed).toBe(true);
  });
});

function performHandshakeWith(headers: Record<string, string>, method = "GET") {
  const sock = fakeSocket();
  const result = performHandshake(fakeReq(headers, method), sock.socket, []);
  return { result, written: sock.written(), destroyed: sock.state.destroyed };
}

function omitKey(headers: Record<string, string>): Record<string, string> {
  const { "sec-websocket-key": _omit, ...rest } = headers;
  return rest;
}
