export interface RequestAdapter {
  rawHeaders(req: unknown): Record<string, string | string[] | undefined> | Headers;
  signal(req: unknown): AbortSignal;
  background(fn: () => Promise<unknown>): void;
}
