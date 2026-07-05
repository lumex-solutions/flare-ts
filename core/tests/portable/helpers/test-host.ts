/**
 * Resolves the executing vitest pool's runtime adapter and builds FlareHost
 * instances for portable integration tests. Synthetic flare.json defaults to {}.
 */
import type { JsonObject } from "@flare-ts/lib";
import type { ExtensionMembers, HostExtension } from "../../../src/lib/host/extensions/extension.js";
import type { node } from "../../../src/lib/host/runtime/node.js";
import { FlareHost } from "../../../src/index.js";

/** Injected per vitest project via `define` (see vitest.config*.ts); absent means the env decides. */
declare const __FLARE_TEST_ADAPTER__: string | undefined;

/** Type-only view of the node adapter: the authoring shape portable suites are typed against. */
type NodeAdapter = typeof node;

/** The adapters the portable root can execute on. */
export type PortableAdapterName = "node" | "cloudflare";

/**
 * Returns the adapter name the executing pool resolves, in precedence order: the pool's compile-time `define`,
 * then the `FLARE_TEST_ADAPTER` env var, then node.
 */
export function portableAdapterName(): PortableAdapterName {
  if (typeof __FLARE_TEST_ADAPTER__ === "string") return __FLARE_TEST_ADAPTER__ as PortableAdapterName;
  const env = typeof process === "undefined" ? undefined : process.env["FLARE_TEST_ADAPTER"];
  return env === "cloudflare" ? "cloudflare" : "node";
}

// Resolved once at module load (top-level await) so testHost stays synchronous inside suites.
// Variable specifiers + @vite-ignore: both helper modules are runtime-typed, and a static specifier
// would pull a runtime root's types into the other pool's tsconfig. Each resolves only in its pool.
const adapterFor: (flareJson: JsonObject) => unknown = await (async () => {
  if (portableAdapterName() === "cloudflare") {
    const spec = "../../cloudflare/helpers/cf-test-adapter.js";
    const mod = (await import(/* @vite-ignore */ spec)) as {
      cfTestAdapter: (flareJson: JsonObject) => unknown;
    };
    return (flareJson: JsonObject) => mod.cfTestAdapter(flareJson);
  }
  const spec = "../../node/helpers/node-adapter.js";
  const mod = (await import(/* @vite-ignore */ spec)) as {
    nodeAdapter: (flareJson: JsonObject) => unknown;
  };
  return (flareJson: JsonObject) => mod.nodeAdapter(flareJson);
})();

/**
 * Builds a FlareHost for portable test suites using the executing pool's adapter. Supplies a
 * synthetic `flareJson` (default `{}`) and `FLARE_MODE=test`; nothing is read from disk.
 */
export function testHost<const E extends readonly HostExtension[] = readonly []>(
  flareJson: JsonObject = {},
  extensions?: E,
): FlareHost<NodeAdapter> & ExtensionMembers<E> {
  // The node-adapter typing is the portable authoring surface; when the cloudflare pool resolves
  // the cf test adapter instead, the host still satisfies everything a portable suite may touch.
  return new FlareHost(adapterFor(flareJson) as NodeAdapter, extensions);
}
