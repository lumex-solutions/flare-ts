/**
 * Node-rooted deliberately: the claim is that FlareResponse's byte-length fast path selects
 * Buffer.byteLength when Buffer exists at module load, a node-only global the portable root
 * must not name (the portable mirror covers the manual utf8 accumulator).
 */
import { describe, expect, it } from "vitest";
import { FlareResponse } from "../../../../../../src/index.js";

describe("utf8 byte length native fast path", () => {
  it("matches Buffer.byteLength when Buffer is defined at module load", () => {
    // The module-private `_nativeByteLength` is selected at module-load time; on node Buffer is
    // defined, so the native path is active. Representative ASCII, BMP, and astral strings.
    const cases = ["hello", "aé€", "😀", "abc 123 €"];
    for (const c of cases) {
      const r = new FlareResponse(200, c);
      expect(r.headers["Content-Length"]).toBe(String(Buffer.byteLength(c)));
    }
  });
});
