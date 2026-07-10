/**
 * Build-time validator for Durable Object mount subtree conflicts in the Cloudflare mount pipeline.
 */
import type { IValidator, ValidationError } from "../../../../validation/types.js";
import type { CfMountContext } from "./composite.js";

/**
 * A normalised path segment for overlap comparison:
 *   - `literal` strings match only themselves.
 *   - `param` (`:name`) matches any single segment.
 *   - `wildcard` (`*rest`) matches zero or more remaining segments (absorbs the rest of the path).
 */
type NormSegment = { kind: "literal"; value: string; } | { kind: "param"; } | { kind: "wildcard"; };

/**
 * Checks each mount record's claimed subtree ({ mountPath, mountPath/*rest }) for overlap with any
 * developer front-door route, any front-door group prefix, or any other mount.
 *
 * Runs BEFORE mount routes install, over the pre-install front-door snapshot. The mounted
 * subtree is owned exclusively by the Durable Object: any developer route or other mount
 * that can match a path inside it is a `MOUNT_ROUTE_CONFLICT`.
 */
export class MountConflictValidator implements IValidator<CfMountContext> {
  validate(ctx: CfMountContext): ValidationError[] {
    const errors: ValidationError[] = [];

    // Each mount claims two patterns: the bare path and the wildcard extension.
    const mountClaims = ctx.mounts.map((m) => ({
      mount: m,
      bare: parseSegments(m.mountPath),
      wild: parseSegments(`${m.mountPath}/*rest`),
    }));

    const devPatterns = ctx.frontDoorPatterns.map((p) => ({ path: p, segs: parseSegments(p) }));
    const groupPrefixSegs = ctx.groupPrefixes.map((p) => ({ path: p, segs: parseSegments(p) }));

    for (let mi = 0; mi < mountClaims.length; mi++) {
      const claim = mountClaims[mi]!;

      // A mount path that sits AT or UNDER a front-door group prefix is a conflict: the group owns
      // that subtree on the front door, so forwarding everything under the mount would collide with
      // (current or future) group routes. `mount.segs` starting with `prefix.segs` (segment-wise)
      // means the mount is at or under the prefix.
      for (const group of groupPrefixSegs) {
        if (mountAtOrUnderPrefix(claim.bare, group.segs)) {
          errors.push({
            severity: "error",
            code: "MOUNT_ROUTE_CONFLICT",
            message: `Durable Object mount "${claim.mount.mountPath}" sits at or under front-door group prefix `
              + `"${group.path}". The group owns that subtree on the front door.`,
            hint: `Mount the Durable Object outside the "${group.path}" group prefix, or move the group.`,
          });
        }
      }

      // Check against developer front-door routes.
      for (const dev of devPatterns) {
        const example = overlapExample(claim.bare, dev.segs) ?? overlapExample(claim.wild, dev.segs);
        if (example !== null) {
          errors.push({
            severity: "error",
            code: "MOUNT_ROUTE_CONFLICT",
            message: `Durable Object mount "${claim.mount.mountPath}" conflicts with front-door route "${dev.path}": `
              + `both match "${example}". The "${claim.mount.mountPath}" subtree is owned by the mounted Durable Object.`,
            hint: `Move the conflicting route outside the mounted subtree, or change the mount path so it does `
              + `not overlap "${dev.path}".`,
          });
        }
      }

      // Check against other mounts (each unordered pair once).
      for (let oi = mi + 1; oi < mountClaims.length; oi++) {
        const other = mountClaims[oi]!;
        const claimPatterns = [claim.bare, claim.wild];
        const otherPatterns = [other.bare, other.wild];

        let conflictExample: string | null = null;
        outer: for (const cp of claimPatterns) {
          for (const op of otherPatterns) {
            const ex = overlapExample(cp, op);
            if (ex !== null) {
              conflictExample = ex;
              break outer;
            }
          }
        }

        if (conflictExample !== null) {
          errors.push({
            severity: "error",
            code: "MOUNT_ROUTE_CONFLICT",
            message: `Durable Object mount "${claim.mount.mountPath}" conflicts with mount "${other.mount.mountPath}": `
              + `both match "${conflictExample}". The "${claim.mount.mountPath}" subtree is owned by the mounted `
              + `Durable Object.`,
            hint: `Give each Durable Object a distinct, non-overlapping mount path.`,
          });
        }
      }
    }

    return errors;
  }
}

/**
 * Returns true when `mount` sits AT or UNDER `prefix`: every prefix segment matches the
 * corresponding mount segment (literals must be equal; a param or wildcard on either side matches),
 * and the mount has at least as many segments as the prefix. A prefix longer than the mount can
 * never contain it.
 */
function mountAtOrUnderPrefix(mount: NormSegment[], prefix: NormSegment[]): boolean {
  if (prefix.length > mount.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!segmentsCompatible(mount[i]!, prefix[i]!)) return false;
  }
  return true;
}

function parseSegments(path: string): NormSegment[] {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s): NormSegment => {
      if (s.startsWith("*")) return { kind: "wildcard" };
      if (s.startsWith(":")) return { kind: "param" };
      return { kind: "literal", value: s };
    });
}

/**
 * Returns true if two segments can match the same position: both literals must be equal; a param or
 * wildcard matches anything. (Wildcards also absorb the rest of the path; that is handled by the
 * caller, which short-circuits before reaching here.)
 */
function segmentsCompatible(a: NormSegment, b: NormSegment): boolean {
  if (a.kind === "wildcard" || b.kind === "wildcard") return true;
  if (a.kind === "param" || b.kind === "param") return true;
  return a.kind === "literal" && b.kind === "literal" && a.value === b.value;
}

/**
 * Returns a concrete example path that matches BOTH patterns, or null when no request path can match
 * both. Two patterns overlap exactly when such a path exists. Wildcards absorb all remaining segments
 * of the other pattern (and can absorb zero, so a wildcard alone matches the empty tail).
 */
function overlapExample(patA: NormSegment[], patB: NormSegment[]): string | null {
  let ia = 0;
  let ib = 0;
  const parts: string[] = [];

  while (ia < patA.length && ib < patB.length) {
    const a = patA[ia]!;
    const b = patB[ib]!;

    if (a.kind === "wildcard") {
      while (ib < patB.length) {
        const bSeg = patB[ib]!;
        parts.push(bSeg.kind === "literal" ? bSeg.value : "x");
        ib++;
      }
      ia++;
      continue;
    }
    if (b.kind === "wildcard") {
      while (ia < patA.length) {
        const aSeg = patA[ia]!;
        parts.push(aSeg.kind === "literal" ? aSeg.value : "x");
        ia++;
      }
      ib++;
      continue;
    }

    if (!segmentsCompatible(a, b)) return null;

    if (a.kind === "literal") parts.push(a.value);
    else if (b.kind === "literal") parts.push(b.value);
    else parts.push("x"); // both params

    ia++;
    ib++;
  }

  // A trailing wildcard on either side absorbs zero remaining segments of the other.
  if (ia === patA.length - 1 && patA[ia]!.kind === "wildcard" && ib === patB.length) {
    return "/" + parts.join("/");
  }
  if (ib === patB.length - 1 && patB[ib]!.kind === "wildcard" && ia === patA.length) {
    return "/" + parts.join("/");
  }

  // Both exhausted -> full match (equal depth).
  if (ia === patA.length && ib === patB.length) {
    return "/" + parts.join("/");
  }

  // One pattern has a non-empty, non-wildcard tail -> depths differ -> no overlap.
  return null;
}
