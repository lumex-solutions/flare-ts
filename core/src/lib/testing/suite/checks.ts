/**
 * The prebuilt test suite's checks, each returning its findings: one line per problem, naming the
 * offending route or service. An empty list passes.
 */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareErrorClass } from "../../errors/types.js";
import type { AppGraph } from "../../graph/app-graph.js";
import type { HttpRouteNode } from "../../graph/http-route-node.js";
import type { ValidationError } from "../../validation/types.js";
import type { TestAppHandle } from "../test-app-handle.js";
import type { RoutePolicy } from "./types.js";
import { FlareError } from "../../errors/flare-error.js";
import { wireNameOf } from "../../errors/wire.js";
import { FlareValidationError } from "../../validation/flare-validation-error.js";
import { badInputFor } from "./bad-input.js";

/** One error the suite saw a pipeline dispatch, and the route it had sent the request to. */
export type ObservedError = { readonly route: HttpRouteNode | undefined; readonly error: Error; };

/** Reports a build that threw, each validation error it threw with, and its warnings when `failOnWarnings` is set. */
export function buildFindings(
  // `unknown`: whatever `host.build()` threw, if anything.
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

/**
 * Sends each front-door HTTP route its bad input and reports each 500, the answer to an unhandled error.
 *
 * @param sending - Told which route each request goes to, and `undefined` once it is answered.
 */
export async function badInputFindings(
  app: TestAppHandle,
  sending: (route: HttpRouteNode | undefined) => void,
): Promise<string[]> {
  const findings: string[] = [];
  for (const route of app.graph.routes()) {
    if (route.kind !== "http" || route.durableObject !== undefined) continue;
    for (const request of badInputFor(route)) {
      sending(route);
      const res = await app.fetch(request.target, request.init);
      sending(undefined);
      if (res.status === 500) findings.push(`${route.id} answered ${res.status} to ${request.description}.`);
    }
  }
  return findings;
}

/** Reports each error thrown by a route that declares errors when neither its class nor any class it extends is declared. */
export function undeclaredErrorFindings(observed: readonly ObservedError[]): string[] {
  const findings = new Set<string>();
  for (const { route, error } of observed) {
    if (route === undefined || route.errors.length === 0) continue;
    if (error instanceof FlareError && declares(route, error)) continue;
    findings.add(`${route.id} threw ${error.name}, which it does not declare.`);
  }
  return [...findings];
}

/** Reports each wire name the suite saw two different error classes send. */
export function errorNameFindings(observed: readonly ObservedError[]): string[] {
  const classByName = new Map<string, Function>();
  const findings = new Set<string>();
  for (const { error } of observed) {
    if (!(error instanceof FlareError)) continue;
    const holder = classByName.get(error.name);
    if (holder === undefined) classByName.set(error.name, error.constructor);
    else if (holder !== error.constructor) findings.add(`Two error classes send the wire name "${error.name}".`);
  }
  return [...findings];
}

// A route declares an error when it names the error's class or any class that class extends.
function declares(route: HttpRouteNode, error: FlareError<JsonValue | undefined>): boolean {
  // TypeScript types `constructor` as Function and `Object.getPrototypeOf` as any; on a FlareError, the
  // constructor and each class up its chain to FlareError are FlareError classes.
  for (let cls = error.constructor as FlareErrorClass; cls !== FlareError; cls = Object.getPrototypeOf(cls)) {
    if (route.errors.includes(wireNameOf(cls))) return true;
  }
  return false;
}
