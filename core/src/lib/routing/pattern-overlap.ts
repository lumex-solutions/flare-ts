/**
 * Build-time route-pattern overlap: whether some concrete path can match two patterns.
 * Shared by the HTTP and WebSocket priority-ambiguity validators so both arcs apply one
 * overlap definition, mirroring the shared {@link scoreRoute} ordering rule.
 */
import { splitPath } from "./router.js";

/** A route pattern prepared for overlap checks. */
export type OverlapPattern = {
  readonly segments: string[];
  readonly wild: boolean;
  /** Matchable prefix length: excludes a trailing wildcard segment. */
  readonly prefixLen: number;
};

/** Splits a pattern once into the shape {@link patternsOverlap} consumes. */
export function toOverlapPattern(path: string): OverlapPattern {
  const segments = splitPath(path);
  const wild = segments.at(-1)?.[0] === "*";
  return { segments, wild, prefixLen: wild ? segments.length - 1 : segments.length };
}

/** Whether some concrete path can match both patterns. */
export function patternsOverlap(a: OverlapPattern, b: OverlapPattern): boolean {
  if (!a.wild && !b.wild) {
    if (a.segments.length !== b.segments.length) return false;
    return a.segments.every((seg, k) => segmentsUnify(seg, b.segments[k]!));
  }

  const [wild, other] = a.wild ? [a, b] : [b, a];
  if (!other.wild) {
    // A wildcard captures one or more segments, so the fixed pattern must be
    // deeper than the wildcard's prefix, and the shared prefix must unify.
    if (other.segments.length < wild.prefixLen + 1) return false;
    for (let k = 0; k < wild.prefixLen; k++) {
      if (!segmentsUnify(wild.segments[k]!, other.segments[k]!)) return false;
    }
    return true;
  }

  // Two wildcards overlap when their prefixes unify up to the shorter prefix;
  // the shorter one's wildcard covers the longer one's remaining prefix.
  const shared = Math.min(wild.prefixLen, other.prefixLen);
  for (let k = 0; k < shared; k++) {
    if (!segmentsUnify(wild.segments[k]!, other.segments[k]!)) return false;
  }
  return true;
}

/** Whether one concrete segment string could satisfy both pattern segments. */
function segmentsUnify(x: string, y: string): boolean {
  if (x[0] === ":" || y[0] === ":") return true;
  return x === y;
}
