/** HTTP methods recognised by the router. Order matches {@link METHOD_IDX_MAP}. */
export const SUPPORTED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** Maps each supported HTTP method to its slot index in route handler arrays. */
export const METHOD_IDX_MAP: Record<(typeof SUPPORTED_METHODS)[number], number> = {
  GET: 0,
  POST: 1,
  PUT: 2,
  PATCH: 3,
  DELETE: 4,
  HEAD: 5,
  OPTIONS: 6,
};
