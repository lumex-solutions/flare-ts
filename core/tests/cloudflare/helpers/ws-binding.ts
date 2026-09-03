/**
 * Shared client driver for the real-binding WebSocket suites (integration/transport): one upgraded
 * round trip against the fixture worker. The caller passes `SELF` so this helper stays free of
 * runtime imports (the house pattern for cross-suite helpers).
 */

/** The slice of `cloudflare:test`'s SELF the driver needs. */
type UpgradeFetcher = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};

/** Opens an upgraded WebSocket via `self`, sends `message`, and resolves with the first echoed frame. */
export async function echoOnce(
  self: UpgradeFetcher,
  url: string,
  message: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  protocol: string | null;
  echoed: string;
}> {
  const res = await self.fetch(url, { headers: { Upgrade: "websocket", ...headers } });
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) return { status: res.status, protocol: null, echoed: "" };
  ws.accept();
  const echoed = await new Promise<string>((resolve) => {
    ws.addEventListener("message", (e) => resolve(e.data as string));
    ws.send(message);
  });
  ws.close();
  return { status: res.status, protocol: res.headers.get("Sec-WebSocket-Protocol"), echoed };
}
