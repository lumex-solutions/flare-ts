import type { ValidationError } from "./types.js";

/**
 * Error thrown by {@link FlareHost.build} when one or more validators report
 * `severity: "error"` entries.
 *
 * Carries the validation entries with `severity: "error"` that caused the build to fail.
 */
export class FlareValidationError extends Error {
  /** Validation entries with `severity: "error"` from the failed build. */
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    const errorItems = errors.filter(e => e.severity === "error");
    const lines = errorItems
      .map((e, i) => `  ${i + 1}. [${e.code}] ${e.message}${e.hint ? `\n     Hint: ${e.hint}` : ""}`)
      .join("\n");
    super(
      `[flare] Build failed with ${errorItems.length} validation error${
        errorItems.length === 1 ? "" : "s"
      }:\n\n${lines}\n`,
    );
    this.name = "FlareValidationError";
    this.errors = errors;
  }
}
