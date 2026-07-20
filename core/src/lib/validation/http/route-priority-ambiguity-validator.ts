/**
 * Build-time warning for equal-specificity routes whose patterns can match the same path.
 */
import type { OverlapPattern } from "../../routing/pattern-overlap.js";
import type { IValidator, ValidationError } from "../types.js";
import type { HttpValidationContext } from "./composite.js";
import { joinRoutePath } from "../../arcs/http/routing/path.js";
import { _getRoutes } from "../../arcs/http/routing/route-store.js";
import { normaliseRoutePattern } from "../../routing/path.js";
import { patternsOverlap, toOverlapPattern } from "../../routing/pattern-overlap.js";
import { scoreRoute } from "../../routing/router.js";

type PatternEntry = {
  fullPath: string;
  pattern: OverlapPattern;
  score: number;
  /** Registration ordinal; the router's stable sort makes the earlier entry win a score tie. */
  order: number;
};

/**
 * Detects overlap the matcher resolves silently: two routes with equal specificity
 * scores that can both match some path. The outcome is deterministic (the stable
 * sort makes registration order decide), but the ambiguity is invisible at the
 * registration site, so it surfaces as a warning naming both routes, the shared
 * score, and the winner. Exact structural duplicates are errors and are reported
 * by {@link DuplicateRouteValidator}, not here.
 */
export class RoutePriorityAmbiguityValidator implements IValidator<HttpValidationContext> {
  /** Reports a `ROUTE_PRIORITY_AMBIGUITY` warning per overlapping equal-score route pair. */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    // One entry per structural pattern: methods share a pattern, and exact
    // duplicates are the duplicate-route validator's findings.
    const seen = new Set<string>();
    const entries: PatternEntry[] = [];
    let order = 0;
    for (const controller of ctx.controllers) {
      for (const route of _getRoutes(controller.cls)) {
        const fullPath = joinRoutePath(controller.path, route.path);
        order++;
        const key = normaliseRoutePattern(fullPath);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          fullPath,
          pattern: toOverlapPattern(fullPath),
          score: scoreRoute(fullPath),
          order,
        });
      }
    }

    // Pairwise over distinct patterns; the route cap bounds this at build time.
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (a.score !== b.score) continue;
        if (!patternsOverlap(a.pattern, b.pattern)) continue;
        const winner = a.order < b.order ? a : b;
        errors.push({
          severity: "warning",
          code: "ROUTE_PRIORITY_AMBIGUITY",
          message: `Routes "${a.fullPath}" and "${b.fullPath}" have equal specificity (score ${a.score}) `
            + `and can match the same path. Registration order decides: "${winner.fullPath}" wins.`,
          hint: `Make one route more specific, or keep the registration order deliberate.`,
        });
      }
    }

    return errors;
  }
}
