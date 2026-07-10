/**
 * The CORS vocabulary: the authoring config and its compiled per-route policy.
 */
/**
 * Configuration for a CORS policy, declared at arc or group level.
 * All behavior derives from the WHATWG Fetch Living Standard §3.3.
 */
export type CorsConfig = {
  /**
   * Which origins may make cross-origin requests to routes covered by this policy.
   *
   * - `'*'`: any origin (incompatible with `credentials: true`)
   * - `string`: a single exact-match origin
   * - `string[]`: an explicit allowlist; checked via O(1) Set lookup at request time
   * - `(origin) => boolean | Promise<boolean>`: evaluated at request time; both sync and async supported
   *
   * Partial wildcards such as `'*.example.com'` are not valid and produce a hard build error.
   */
  origins: string | string[] | ((origin: string) => boolean | Promise<boolean>);
  /**
   * HTTP methods permitted in cross-origin requests.
   * When omitted, `build()` derives the allowed set from the registered handlers for each path.
   */
  methods?: string[];
  /**
   * Request headers the server accepts in cross-origin requests.
   * Populates `Access-Control-Allow-Headers` on preflight responses.
   * When omitted, the header is not written (only CORS-safelisted headers pass).
   */
  headers?: string[];
  /**
   * Response headers exposed to client-side JavaScript beyond the safelisted defaults.
   * Populates `Access-Control-Expose-Headers` on actual responses.
   */
  expose?: string[];
  /**
   * Whether cross-origin requests may include credentials.
   * Incompatible with `origins: '*'`: a hard build error if combined.
   */
  credentials?: boolean;
  /**
   * Seconds the browser may cache a preflight result.
   * Defaults to `7200` (Chrome's maximum honored value). Must not be negative.
   */
  maxAge?: number;
};

/**
 * Fully precomputed CORS policy stored on each pipeline.
 * Produced once at `build()` time and reused for every request.
 */
export type CompiledCorsPolicy = {
  readonly isWildcard: boolean;
  readonly allowedOrigins: ReadonlySet<string> | null;
  readonly originFn: ((origin: string) => boolean | Promise<boolean>) | null;
  /** `'*'` for wildcard policies; `null` for all others (origin echoed at runtime). */
  readonly allowOriginHeader: string | null;
  /** Always present. Derived from route graph or overridden by `config.methods`. */
  readonly allowMethodsHeader: string;
  readonly allowHeadersHeader: string | null;
  readonly exposeHeadersHeader: string | null;
  readonly maxAgeHeader: string;
  readonly credentialsHeader: string | null;
  /** `false` only for wildcard. All other policies set `Vary: Origin`. */
  readonly varyOrigin: boolean;
};
