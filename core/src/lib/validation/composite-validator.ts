/**
 * The composite runner that drives an ordered list of validators over one shared context.
 */
import type { IValidator, ValidationError } from "./types.js";

/**
 * Runs an ordered list of inner validators against the same context.
 *
 * Every inner validator runs unconditionally; errors are collected, not short-circuited.
 *
 * @typeParam TContext - The shape of the validation context shared by all inner validators.
 * @internal
 */
export class CompositeValidator<TContext> implements IValidator<TContext> {
  constructor(private readonly validators: IValidator<TContext>[]) {}

  /**
   * Runs every inner validator and returns the concatenated list of validation errors.
   */
  validate(ctx: TContext): ValidationError[] {
    const results: ValidationError[] = [];
    for (const v of this.validators) {
      results.push(...v.validate(ctx));
    }
    return results;
  }
}
