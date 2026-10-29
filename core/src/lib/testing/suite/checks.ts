/**
 * The prebuilt test suite's checks, each returning its findings: one line per problem, naming the
 * offending route or service. An empty list passes.
 */
import type { AppGraph } from "../../graph/app-graph.js";
import type { ValidationError } from "../../validation/types.js";
import type { TestAppHandle } from "../test-app-handle.js";
import type { RoutePolicy } from "./types.js";
import { FlareValidationError } from "../../validation/flare-validation-error.js";

/** Reports a build that threw, each validation error it threw with, and the warnings when they count. */
export function buildFindings(
  failure: unknown,
  warnings: readonly ValidationError[],
  failOnWarnings: boolean,
): string[] {
  const findings: string[] = [];
  if (failure instanceof FlareValidationError) {
    findings.push(...failure.errors.map((error) => `[${error.code}] ${error.message}`));
  } else if (failure !== undefined) {
    findings.push(`The build threw: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
  if (failOnWarnings) findings.push(...warnings.map((warning) => `[${warning.code}] ${warning.message}`));
  return findings;
}

/** Reports a liveness or readiness route that does not answer 200. */
export async function healthFindings(
  app: TestAppHandle,
  paths: { readonly live: string | undefined; readonly ready: string | undefined; },
): Promise<string[]> {
  const findings: string[] = [];
  for (const path of [paths.live, paths.ready]) {
    if (path === undefined) continue;
    const res = await app.fetch(`GET ${path}`);
    if (res.status !== 200) findings.push(`GET ${path} answered ${res.status} ${await res.text()}`);
  }
  return findings;
}

/** Reports every route the policy's path matches that does not run its middleware, or a path no route matches. */
export function policyFindings(graph: AppGraph, policy: RoutePolicy): string[] {
  const matched = graph.routes({ path: policy.path });
  if (matched.length === 0) return [`No route matches ${policy.path}.`];
  const runsAnywhere = graph.routes({ through: policy.runs }).length > 0;
  return matched
    .filter((route) => !route.runs(policy.runs))
    .map((route) => {
      if (route.kind === "ws") return `${route.id} is a WebSocket route, which runs no HTTP middleware.`;
      if (!runsAnywhere) return `${route.id} skips it: ${policy.runs.name} runs on no route.`;
      return `${route.id} skips it.`;
    });
}
