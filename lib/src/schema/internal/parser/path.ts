/** @internal Prefixes a nested field path with its parent object key. */
export function prefixNestedPath(key: string, path: string): string {
  if (!path) return key;
  return path.startsWith("[") ? `${key}${path}` : `${key}.${path}`;
}

/** @internal Prefixes a nested field path with a top-level array index. */
export function prefixRootArrayItemPath(idx: number, path: string): string {
  return path ? `[${idx}].${path}` : `[${idx}]`;
}
