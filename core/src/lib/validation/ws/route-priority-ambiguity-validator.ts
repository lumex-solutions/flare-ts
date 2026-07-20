/**
 * Build-time warning for equal-specificity WebSocket routes whose patterns can match the
 * same upgrade path.
 */
import type { OverlapPattern } from "../../routing/pattern-overlap.js";
import type { IValidator, ValidationError } from "../types.js";
import type { WsValidationContext } from "./composite.js";
import { normaliseRoutePattern } from "../../routing/path.js";
import { patternsOverlap, toOverlapPattern } from "../../routing/pattern-overlap.js";
import { scoreRoute } from "../../routing/router.js";

type PatternEntry = {
  path: string;
  pattern: OverlapPattern;
  score: number;
  /** Registration ordinal; the matcher's stable sort makes the earlier entry win a score tie. */
  order: number;
};

/**
 * The WebSocket arc's counterpart to the HTTP `RoutePriorityAmbiguityValidator`: both
 * arcs share one specificity rule ({@link scoreRoute}) and one overlap definition, so a
 * silent equal-score tie on upgrade paths surfaces the same way it does for HTTP routes.
 * Exact structural duplicates are `WS_DUPLICATE_ROUTE` errors, not warnings here.
 */
export class WsRoutePriorityAmbiguityValidator implements IValidator<WsValidationContext> {
  /** Reports a `WS_ROUTE_PRIORITY_AMBIGUITY` warning per overlapping equal-score pattern pair. */
  validate(ctx: WsValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    const seen = new Set<string>();
    const entries: PatternEntry[] = [];
    ctx.wsPatterns.forEach((path, order) => {
      const key = normaliseRoutePattern(path);
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ path, pattern: toOverlapPattern(path), score: scoreRoute(path), order });
    });

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (a.score !== b.score) continue;
        if (!patternsOverlap(a.pattern, b.pattern)) continue;
        const winner = a.order < b.order ? a : b;
        errors.push({
          severity: "warning",
          code: "WS_ROUTE_PRIORITY_AMBIGUITY",
          message: `WebSocket routes "${a.path}" and "${b.path}" have equal specificity (score ${a.score}) `
            + `and can match the same upgrade path. Registration order decides: "${winner.path}" wins.`,
          hint: `Make one route more specific, or keep the registration order deliberate.`,
        });
      }
    }

    return errors;
  }
}
