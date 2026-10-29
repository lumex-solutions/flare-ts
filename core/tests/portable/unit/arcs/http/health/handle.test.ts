/** Unit tests for HealthHandle: the readiness checks it registers, and the names and inject keys it refuses. */
import { describe, expect, it } from "vitest";
import type { HealthCheckFn, HealthCheckRegistration } from "../../../../../../src/lib/arcs/http/health/types.js";
import { HealthHandle } from "../../../../../../src/lib/arcs/http/health/handle.js";
import { FlareService } from "../../../../../../src/lib/services/composition/flare-service.js";

class SearchIndex extends FlareService {
  static override deps = [];

  isWarm(): boolean {
    return true;
  }
}

describe("check()", () => {
  it("registers each check in order with its inject map, none for a check without options", () => {
    const warm = () => true;
    const indexed: HealthCheckFn<{ search: typeof SearchIndex; }> = ({ search }) => search.isWarm();
    const checks: HealthCheckRegistration[] = [];
    new HealthHandle(checks)
      .check("warm-cache", warm)
      .check("search-index", { inject: { search: SearchIndex } }, indexed);

    expect(checks).toEqual([
      { name: "warm-cache", inject: {}, run: warm },
      { name: "search-index", inject: { search: SearchIndex }, run: indexed },
    ]);
  });

  it("refuses a second check with the same name", () => {
    const health = new HealthHandle([]).check("database", () => true);

    expect(() => health.check("database", () => true)).toThrow('Health check "database" is already registered.');
  });

  it("refuses an inject key the scope reserves", () => {
    // @ts-expect-error - config is reserved on every scope
    expect(() => new HealthHandle([]).check("search-index", { inject: { config: SearchIndex } }, () => true)).toThrow(
      /config/,
    );
  });
});
