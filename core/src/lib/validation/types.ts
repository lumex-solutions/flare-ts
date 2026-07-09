/**
 * Validation vocabulary: severity, the error entry shape, and the validator contract.
 */
/**
 * Severity assigned to a {@link ValidationError}.
 *
 * - `"error"` - fails the build; reported in {@link FlareValidationError}.
 * - `"warning"` - surfaces in build output but does not fail the build.
 */
export type ValidationSeverity = "error" | "warning";

/**
 * Single entry produced by a validator describing a problem in the host configuration.
 */
export type ValidationError = {
  readonly severity: ValidationSeverity;
  /** Stable, machine-readable identifier for the kind of problem (e.g. `"DUPLICATE_ROUTE_PATTERN"`). */
  readonly code: string;
  /** Human-readable description of the problem. */
  readonly message: string;
  /** Optional remediation guidance shown alongside the message. */
  readonly hint?: string;
};

/**
 * Validator contract used by the pre-build validation pass.
 *
 * Implementations collect every problem they find and return them as an array;
 * they never throw and never short-circuit on the first error.
 *
 * @typeParam TContext - The validation context the implementation inspects.
 * @internal
 */
export interface IValidator<TContext> {
  validate(ctx: TContext): ValidationError[];
}
