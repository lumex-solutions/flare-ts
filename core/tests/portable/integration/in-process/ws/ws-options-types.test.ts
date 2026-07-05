/**
 * Compile-time tests for the WS route-options two-form split (HTTP parity): spell the descriptor
 * fields loose in the options, OR pass a socketContract entry as `contract:` - never both. Cross-arc
 * entries and whole contract maps are rejected. The file passing `tsc` IS the assertion (the
 * `@ts-expect-error` lines fail the build if they stop erroring); the single runtime `it` only
 * anchors it as a vitest file. See WebSocketToken in ws-contract.ts.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { str } from "@flare-ts/lib/schema";
import { httpContract, socketContract } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const Chat = socketContract({ chat: { params: { room: str } } });
const Api = httpContract({ getThing: { query: { room: str } } });

const host = testHost();

// Inline descriptor literal: params are inferred onto scope.input.params.
host.ws.route("/inline/:room", { params: { room: str } }).open((_socket, scope) => {
  type _room = Expect<Equal<typeof scope.input.params.room, string>>;
});

// Branded entry: same inference through the socketContract entry.
host.ws.route("/entry/:room", { contract: Chat.chat }).open((_socket, scope) => {
  type _room = Expect<Equal<typeof scope.input.params.room, string>>;
});

// @ts-expect-error - an "http" contract entry cannot be used as a WS route's `contract`, even when
// its fields (a string query) are structurally compatible with a WebSocketDescriptor.
host.ws.route("/bad-kind", { contract: Api.getThing });

// @ts-expect-error - a whole socketContract map is not a single entry; pass `Chat.chat`, not `Chat`.
host.ws.route("/bad-map", { contract: Chat });

// @ts-expect-error - the two forms never mix: a `contract:` route cannot also spell loose keys.
host.ws.route("/bad-mix", { contract: Chat.chat, params: { room: str } });

describe("ws route options types", () => {
  it("compiles: inline vs entry acceptance and cross-arc rejection are enforced by tsc", () => {
    expect(true).toBe(true);
  });
});
