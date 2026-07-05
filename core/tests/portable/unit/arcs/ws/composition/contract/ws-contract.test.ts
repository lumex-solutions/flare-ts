/** Unit tests for socketContract descriptor branding and shape. */
import { describe, expect, it } from "vitest";
import { schema, str } from "@flare-ts/lib/schema";
import { socketContract } from "../../../../../../../src/lib/arcs/ws/composition/contract/ws-contract.js";
import { CONTRACT_BRAND, contractKind } from "../../../../../../../src/lib/contract/contract.js";

const MsgIn = schema({ text: str });

describe("socketContract", () => {
  it("produces a 'ws'-kind contract carrying the descriptor entries", () => {
    const c = socketContract({
      chat: { incoming: MsgIn, params: { room: str } },
    });
    expect((c as Record<PropertyKey, unknown>)[CONTRACT_BRAND]).toBe("ws");
    expect(contractKind(c)).toBe("ws");
    expect(c.chat.incoming).toBe(MsgIn);
  });

  it("brands via a symbol key so Object.keys yields only route entries", () => {
    const c = socketContract({ chat: {}, feed: {} });
    expect(Object.keys(c).sort()).toEqual(["chat", "feed"]);
  });
});
