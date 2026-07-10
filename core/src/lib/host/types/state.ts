/**
 * The host lifecycle-state vocabulary.
 */

/**
 * Lifecycle state of a {@link FlareHost}, observable via {@link FlareHost.state}.
 *
 * Runtime advances this state automatically, and application code treats it as read-only.
 *
 * - `"starting"` - Host is initializing and not yet accepting requests.
 * - `"ready"` - Host is accepting requests.
 * - `"draining"` - Graceful shutdown is in progress and new requests receive `503`.
 * - `"stopped"` - Teardown is complete.
 */
export type HostState = "starting" | "ready" | "draining" | "stopped";
