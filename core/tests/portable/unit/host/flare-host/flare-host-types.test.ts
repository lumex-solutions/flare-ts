/**
 * Compile-time claims for the FlareHost export pair: the construct signature's
 * runtime-stamped member typing and the FlareHost type alias's parity with it.
 */
import { describe, expect, it } from "vitest";
import type { FlareHost as FlareHostType } from "../../../../../src/index.js";
import type { ExtensionMembers } from "../../../../../src/lib/host/extensions/extension.js";
import type { node } from "../../../../../src/lib/host/runtime/node/node.js";
import { defineHostExtension, FlareHost } from "../../../../../src/index.js";
import { makeAdapter } from "./_fixtures.js";

type NodeAdapter = typeof node;

const widget = defineHostExtension(() => ({
  widget: { spin: (): number => 42 },
  widgetCount: 3,
}));

describe("FlareHost construct-signature typing (compile-time claims)", () => {
  it("types extension members straight from the extensions array argument", () => {
    const host = new FlareHost(makeAdapter(), [widget]);
    // Compile-time: both members exist with their installed types.
    const n: number = host.widget.spin();
    const c: number = host.widgetCount;
    expect(n).toBe(42);
    expect(c).toBe(3);
  });

  it("a host constructed without an extension does not have its members", () => {
    const host = new FlareHost(makeAdapter());
    // @ts-expect-error widget is only stamped when the extension is passed.
    void host.widget;
    expect("widget" in host).toBe(false);
  });

  it("the FlareHost type alias carries extension members through its E parameter", () => {
    // Compile-only: the annotated shape accepts the constructed intersection with
    // no manual & ExtensionMembers<E> re-append.
    const host: FlareHostType<NodeAdapter, readonly [typeof widget]> = new FlareHost(
      // The fixture adapter satisfies the node adapter's authoring shape for typing purposes.
      makeAdapter() as unknown as NodeAdapter,
      [widget] as const,
    );
    const n: number = host.widget.spin();
    expect(n).toBe(42);
  });

  it("the alias without E matches the no-extensions construction exactly", () => {
    const host: FlareHostType<NodeAdapter> = new FlareHost(makeAdapter() as unknown as NodeAdapter);
    expect(typeof host.build).toBe("function");
  });

  it("ExtensionMembers of the empty tuple contributes no members", () => {
    type None = ExtensionMembers<readonly []>;
    // Compile-time: an empty-extension host gains no index signature or stray keys.
    const none: None = {};
    expect(none).toEqual({});
  });
});
