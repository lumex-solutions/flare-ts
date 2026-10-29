/** The requests the prebuilt suite sends each route: input its contract should refuse, or none at all. */
import type { JsonSchema } from "@flare-ts/lib/schema";
import type { HttpRouteNode } from "../../graph/http-route-node.js";
import type { TestRequestInit } from "../types/flare-test-req.js";

/** One request the suite sends a route, and what is wrong with it. */
export type BadRequest = {
  /** What is wrong with the request, as a finding names it, e.g. "a body that is not JSON". */
  readonly description: string;
  /** `METHOD /path?query`, as `app.fetch` takes it. */
  readonly target: string;
  readonly init?: TestRequestInit;
};

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * Returns the bad requests to send `route`, read from its input schemas: text where a numeric or
 * boolean path param or query parameter belongs, no query when some is required, and a body that is not
 * JSON, is the wrong JSON type, or lacks its required fields. A route that declares no input gets one
 * bare request.
 */
export function badRequestsFor(route: HttpRouteNode): BadRequest[] {
  const { route: params, query, body } = route.input;
  const requests: BadRequest[] = [];
  const target = (badParam?: string, search = ""): string =>
    `${route.method} ${fillPath(route.path, params, badParam)}${search}`;

  for (const [name, schema] of propertiesOf(params)) {
    if (refusesText(schema)) requests.push({ description: `an invalid :${name}`, target: target(name) });
  }
  if (requiredOf(query).length > 0) requests.push({ description: "no query parameters", target: target() });
  for (const [name, schema] of propertiesOf(query)) {
    if (refusesText(schema)) {
      requests.push({ description: `an invalid ${name} query parameter`, target: target(undefined, `?${name}=x`) });
    }
  }
  if (body !== undefined && !("format" in body && body.format === "binary")) {
    requests.push({
      description: "a body that is not JSON",
      target: target(),
      init: { body: "{", headers: JSON_HEADERS },
    });
    let wrongType: string | undefined;
    if ("items" in body) wrongType = "{}";
    else if ("properties" in body) wrongType = "[]";
    if (wrongType !== undefined) {
      requests.push({
        description: "a JSON body of the wrong type",
        target: target(),
        init: { body: wrongType, headers: JSON_HEADERS },
      });
    }
    if (requiredOf(body).length > 0) {
      requests.push({
        description: "a JSON body missing its required fields",
        target: target(),
        init: { body: "{}", headers: JSON_HEADERS },
      });
    }
  }
  if (requests.length === 0) requests.push({ description: "a request with no input", target: target() });
  return requests;
}

// Fills each `:param` with a value its schema accepts (or "x" for the one under test) and each wildcard
// with one segment.
function fillPath(path: string, params: JsonSchema | undefined, badParam: string | undefined): string {
  const schemas = new Map(propertiesOf(params));
  return path.split("/").map((segment) => {
    if (segment.startsWith("*")) return "x";
    if (!segment.startsWith(":")) return segment;
    const name = segment.slice(1);
    if (name === badParam) return "x";
    const schema = schemas.get(name);
    return schema !== undefined && refusesText(schema) ? "1" : "x";
  }).join("/");
}

function propertiesOf(schema: JsonSchema | undefined): [string, JsonSchema][] {
  return schema !== undefined && "properties" in schema ? Object.entries(schema.properties) : [];
}

function requiredOf(schema: JsonSchema | undefined): readonly string[] {
  return schema !== undefined && "required" in schema ? schema.required ?? [] : [];
}

// A number or boolean parses from a path or query string, so arbitrary text such as "x" fails it.
function refusesText(schema: JsonSchema): boolean {
  return "type" in schema && (schema.type === "integer" || schema.type === "number" || schema.type === "boolean");
}
