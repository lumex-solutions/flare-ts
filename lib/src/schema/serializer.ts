/**
 * Schema-driven JSON output: the compiled fast serializer and the JSON Schema
 * exporter, both introspecting tokens through the descriptor brand.
 */
import type { Primitive } from "./primitives/index.js";
import type { JsonValue, OpaqueSchemaToken } from "./schema.js";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "./schema.js";

type ArraySchemaDescriptor = readonly [IntrospectableSchemaToken];

type ObjectDescriptor = Record<string, DescriptorField>;
type SchemaDescriptor = ObjectDescriptor | ArraySchemaDescriptor;
type IntrospectableSchemaToken = OpaqueSchemaToken & {
  readonly [SCHEMA_DESCRIPTOR]: SchemaDescriptor;
  readonly [SCHEMA_REQUIRED]?: boolean;
};

type IntrospectableArraySchemaToken = OpaqueSchemaToken & {
  readonly [SCHEMA_DESCRIPTOR]: ArraySchemaDescriptor;
  readonly [SCHEMA_REQUIRED]?: boolean;
};

type DescriptorField = Primitive | IntrospectableSchemaToken;

type DatePrimitiveField = Primitive & { readonly _type: "date"; readonly _format?: string; };
type ArrayPrimitiveField = Primitive & { readonly _item?: Primitive; };

type DiscriminatedDescriptor = {
  discriminant: string;
  branches: Record<string, ObjectDescriptor>;
};

/**
 * The JSON Schema fragment shape {@link toJsonSchema} produces.
 */
export type JsonSchema =
  | { type: "object"; properties: Record<string, JsonSchema>; required?: string[]; }
  | { type: "object"; additionalProperties: JsonSchema; }
  | { type: "array"; items: JsonSchema; }
  | {
    type: "string";
    format?: string;
    enum?: readonly string[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  }
  | { type: "integer" | "number"; minimum?: number; maximum?: number; }
  | { type: "boolean"; }
  | { anyOf: JsonSchema[]; }
  | Record<string, never>;

/**
 * A compiled function serializing a JSON value that matches its source schema token.
 */
export type SchemaSerializer = (doc: JsonValue) => string;

const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const DIRTY_RE = /[\x00-\x1f"\\]/;

const DISCRIMINANT_PRIMITIVE: Primitive = {
  _type: "string",
  _required: true,
  jsonSchema: { type: "string" },
};

/**
 * Compiles a fast JSON serializer from a schema token.
 *
 * The compiled serializer outperforms fast-json-stringify on typical API response
 * shapes because Flare's schema carries type information (uuid, date, enum, string
 * vs text) that allows the codegen to skip escape scans and use pre-built LUTs
 * wherever the field domain guarantees safety.
 *
 * Record and discriminated-union descriptors get a SchemaSerializer that delegates
 * to JSON.stringify. Callers see the same shape and behaviour as a compiled one,
 * just without the fast path.
 *
 * @param token - A schema token produced by {@link schema} or {@link model}.
 */
export function compileSerializer(token: OpaqueSchemaToken): SchemaSerializer {
  // Public tokens hide the descriptor brand; the introspectable view is how the
  // compiler reads what schema() stored under SCHEMA_DESCRIPTOR.
  const introspectable = token as IntrospectableSchemaToken;
  const descriptor = introspectable[SCHEMA_DESCRIPTOR] as
    | SchemaDescriptor
    | DiscriminatedDescriptor;

  if (Array.isArray(descriptor)) {
    const first = descriptor[0];
    if (first !== null && typeof first === "object" && "$record" in (first as object)) {
      return jsonStringifyFallback;
    }
    // Top-level array schema: compile item serializer, emit into pre-allocated
    // array and join to avoid growing ConsString ropes on large arrays.
    const itemDescriptor = (descriptor as ArraySchemaDescriptor)[0]![SCHEMA_DESCRIPTOR] as ObjectDescriptor;
    const inner = buildSerializer(itemDescriptor);
    return function serializeArray(doc: JsonValue): string {
      const arr = doc as JsonValue[];
      const parts = new Array<string>(arr.length);
      for (let i = 0; i < arr.length; i++) parts[i] = inner(arr[i]!);
      return "[" + parts.join(",") + "]";
    };
  }

  if (isDiscriminatedDescriptor(descriptor)) {
    return jsonStringifyFallback;
  }

  return buildSerializer(descriptor as ObjectDescriptor);
}

/**
 * Converts a schema token into a JSON Schema Draft 7 object.
 *
 * Supports flat object descriptors, top-level array tokens, record tokens
 * (`[{ $record: … }]`), and discriminated unions. Unrecognized descriptor
 * fields are omitted from `properties` rather than throwing.
 */
export function toJsonSchema(token: OpaqueSchemaToken): JsonSchema {
  return descriptorToJsonSchema((token as IntrospectableSchemaToken)[SCHEMA_DESCRIPTOR]);
}

function isSchemaToken(value: DescriptorField): value is IntrospectableSchemaToken {
  return SCHEMA_BRAND in value;
}

function isSchemaArrayToken(value: DescriptorField): value is IntrospectableArraySchemaToken {
  return isSchemaToken(value) && Array.isArray(value[SCHEMA_DESCRIPTOR]);
}

function isDescriptorValueRequired(value: DescriptorField): boolean {
  if (isSchemaToken(value)) return value[SCHEMA_REQUIRED] !== false;
  return value._required !== false;
}

// Compiles a helper for arrays of schema objects (schema([ItemSchema])).
// Takes a snapshot of the current closure so any enum LUTs or esc captured
// so far are available inside the helper at runtime.
//
// braceEmbedded: when true, itemCode already starts with '{' (the opening brace
// was merged into the first field's key literal by emitFields), so only '}' needs
// appending. Returns the full '[...]' JSON array string so callers need no wrapping.
function buildObjectArrayHelper(
  helperName: string,
  itemCode: string,
  closureArgs: string[],
  closureVals: unknown[],
  braceEmbedded = false,
): (arr: JsonValue[]) => string {
  const itemAssign = braceEmbedded ? `p[i] = (${itemCode}) + '}';` : `p[i] = '{' + (${itemCode}) + '}';`;
  return new Function(
    ...closureArgs,
    `return function ${helperName}(arr){
      const p = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        ${itemAssign}
      }
      return '['+p.join(',')+']';
    }`,
  )(...closureVals) as (arr: JsonValue[]) => string;
}

// Compiles a helper for primitive arrays (array(str), array(int), etc.).
// Pass closure args when itemExpr references helpers (e.g. date(v, format)).
// Returns the full '[...]' JSON array string so callers need no bracket wrapping.
function buildPrimitiveArrayHelper(
  helperName: string,
  itemExpr: string,
  closureArgs: string[] = [],
  closureVals: unknown[] = [],
): (arr: JsonValue[]) => string {
  return new Function(
    ...closureArgs,
    `return function ${helperName}(arr){
      const p = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        p[i] = ${itemExpr};
      }
      return '['+p.join(',')+']';
    }`,
  )(...closureVals) as (arr: JsonValue[]) => string;
}

function jsonStringifyFallback(doc: JsonValue): string {
  return JSON.stringify(doc);
}

function serializeText(str: string): string {
  if (!DIRTY_RE.test(str)) return '"' + str + '"';
  return JSON.stringify(str);
}

function serializeDate(value: Date, format?: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "null";

  switch (format) {
    case "DMY":
    case "MDY":
    case "YMD":
      return '"' + value.toISOString().slice(0, 10) + '"';
    case "TIMESTAMP":
      return String(value.getTime());
    default:
      return '"' + value.toISOString() + '"';
  }
}

function buildSerializer(descriptor: ObjectDescriptor): SchemaSerializer {
  const closureArgs: string[] = ["esc", "date"];
  const closureVals: unknown[] = [serializeText, serializeDate];
  let generatedNameId = 0;

  function nextGeneratedName(prefix: string, key: string): string {
    generatedNameId += 1;
    return `${prefix}_${key}_${generatedNameId}`;
  }

  // wrapBrace: caller guarantees the first field is required, so we embed the
  // opening '{' into the first key literal (saves one runtime concat per item).
  // Only pass true when you know the descriptor's first field is required.
  function emitFields(fields: ObjectDescriptor, acc: string, wrapBrace = false): string {
    const parts: string[] = [];
    let firstReq = true;

    for (const [key, field] of Object.entries(fields)) {
      const required = isDescriptorValueRequired(field);

      // Inline-quote shortcut: str/uuid fields don't need escaping, so we
      // merge the JSON quotes and the comma separator into a single string literal,
      // eliminating one runtime concat per field per item compared to the generic
      // '"key":' + ('"' + x + '"') form.
      const isSafeString = !isSchemaToken(field) && (field._type === "string" || field._type === "uuid");

      if (!VALID_IDENTIFIER.test(key)) {
        throw new Error(`flareSchema: invalid field key "${key}" - must be a valid JS identifier`);
      }

      if (required) {
        const sep = firstReq && wrapBrace ? '{"' : firstReq ? '"' : ',"';
        const kPrefix = `'${sep}${key}":`;
        if (isSafeString) {
          parts.push(`${kPrefix}"' + ${acc}.${key} + '"'`);
        } else {
          parts.push(`${kPrefix}' + ${emitValue(key, field, acc)}`);
        }
        firstReq = false;
      } else {
        if (isSafeString) {
          parts.push(`(${acc}.${key} != null ? ',"${key}":"' + ${acc}.${key} + '"' : '')`);
        } else {
          parts.push(`(${acc}.${key} != null ? ',"${key}":' + ${emitValue(key, field, acc)} : '')`);
        }
      }
    }

    return parts.join("+");
  }

  function emitValue(key: string, field: DescriptorField, acc: string): string {
    // schema([ItemSchema]) - array of objects.
    if (isSchemaArrayToken(field)) {
      const itemDescriptor = field[SCHEMA_DESCRIPTOR][0]![SCHEMA_DESCRIPTOR] as ObjectDescriptor;
      // If the first item field is required we can embed '{' into its key literal,
      // dropping one '{' + concat per item inside the helper.
      const firstItemField = Object.values(itemDescriptor)[0];
      const canEmbedBrace = firstItemField != null && isDescriptorValueRequired(firstItemField);
      const itemCode = emitFields(itemDescriptor, "item", canEmbedBrace);
      const helperName = nextGeneratedName("arrHelper", key);
      // Snapshot before pushing so the helper closes over the current closure state.
      const snapshot = { args: [...closureArgs], vals: [...closureVals] };
      closureArgs.push(helperName);
      closureVals.push(buildObjectArrayHelper(helperName, itemCode, snapshot.args, snapshot.vals, canEmbedBrace));
      // Helper now returns '[...]' directly; no bracket wrapping needed.
      return `${helperName}(${acc}.${key})`;
    }

    // Nested schema token - inline object.
    if (isSchemaToken(field)) {
      const desc = field[SCHEMA_DESCRIPTOR] as ObjectDescriptor;
      const firstNestedField = Object.values(desc)[0];
      const canEmbed = firstNestedField != null && isDescriptorValueRequired(firstNestedField);
      const inner = emitFields(desc, `${acc}.${key}`, canEmbed);
      // When first field is required, '{' is embedded in its key literal; only '}' needed.
      return canEmbed ? `(${inner} + '}')` : `('{' + ${inner} + '}')`;
    }

    // Scalar primitives.
    switch (field._type) {
      case "int":
      case "float":
        return `(+${acc}.${key})`;
      case "bool":
        return `(${acc}.${key} ? 'true' : 'false')`;
      case "string":
      case "uuid":
        return `'"' + ${acc}.${key} + '"'`;
      case "date":
        return `date(${acc}.${key}, ${JSON.stringify((field as DatePrimitiveField)._format)})`;
      case "text":
        return `(esc(${acc}.${key}))`;
      case "enum": {
        const lut = (field as Primitive & { lut: Record<string, string>; }).lut;
        const lutName = nextGeneratedName("lut", key);
        closureArgs.push(lutName);
        closureVals.push(lut);
        return `${lutName}[${acc}.${key}]`;
      }
    }

    // array(str) / array(int) etc - primitive arrays.
    const jsonSchema = (field as Primitive).jsonSchema;
    if ("type" in jsonSchema && jsonSchema.type === "array" && "items" in jsonSchema) {
      const itemType = (jsonSchema as { type: "array"; items: { type?: string; }; }).items.type;
      const itemPrimitive = (field as ArrayPrimitiveField)._item;
      const helperName = nextGeneratedName("arrHelper", key);

      if (itemPrimitive?._type === "date") {
        const itemFormat = (itemPrimitive as DatePrimitiveField)._format;
        const snapshot = { args: [...closureArgs], vals: [...closureVals] };
        closureArgs.push(helperName);
        closureVals.push(
          buildPrimitiveArrayHelper(
            helperName,
            `date(v, ${JSON.stringify(itemFormat)})`,
            snapshot.args,
            snapshot.vals,
          ),
        );
        return `${helperName}(${acc}.${key})`;
      }

      if (itemType === "string") {
        // Join-based approach: one Array.prototype.join call builds the list in
        // the engine without per-element intermediate string allocations.
        // Returns the full '[...]' JSON array so no outer bracket wrapping is needed.
        closureArgs.push(helperName);
        closureVals.push(
          new Function(
            `return function ${helperName}(arr){` + `if(arr.length===0)return'[]';` + `return'["'+arr.join('","')+'"]';`
              + `}`,
          )() as (arr: JsonValue[]) => string,
        );
        return `${helperName}(${acc}.${key})`;
      }

      let itemExpr: string;
      switch (itemType) {
        case "integer":
        case "number":
          itemExpr = `(+v)`;
          break;
        case "boolean":
          itemExpr = `(v ? 'true' : 'false')`;
          break;
        default:
          itemExpr = `JSON.stringify(v)`;
          break;
      }

      closureArgs.push(helperName);
      closureVals.push(buildPrimitiveArrayHelper(helperName, itemExpr));
      // Helper returns '[...]' directly.
      return `${helperName}(${acc}.${key})`;
    }

    // Fallback.
    return `JSON.stringify(${acc}.${key})`;
  }

  const body = emitFields(descriptor, "o");
  return new Function(...closureArgs, `return function serialize(o){ return '{' + ${body} + '}'; }`)(
    ...closureVals,
  ) as SchemaSerializer;
}

function isDiscriminatedDescriptor(
  value: SchemaDescriptor | DiscriminatedDescriptor,
): value is DiscriminatedDescriptor {
  return "discriminant" in value;
}

function schemaTokenToJsonSchema(token: IntrospectableSchemaToken): JsonSchema {
  return descriptorToJsonSchema(token[SCHEMA_DESCRIPTOR]);
}

function descriptorValueToJsonSchema(value: DescriptorField): JsonSchema {
  if (isSchemaToken(value)) return schemaTokenToJsonSchema(value);
  return value.jsonSchema;
}

function descriptorToJsonSchema(descriptor: SchemaDescriptor | DiscriminatedDescriptor): JsonSchema {
  if (Array.isArray(descriptor)) {
    const first = descriptor[0];
    if (first !== null && typeof first === "object" && "$record" in (first as object)) {
      const valueSchema = (first as { $record: OpaqueSchemaToken; }).$record;
      return {
        type: "object",
        additionalProperties: schemaTokenToJsonSchema(valueSchema as IntrospectableSchemaToken),
      };
    }
    return { type: "array", items: schemaTokenToJsonSchema((descriptor as ArraySchemaDescriptor)[0]!) };
  }

  if (isDiscriminatedDescriptor(descriptor)) {
    return {
      anyOf: Object.entries(descriptor.branches).map(([, branchDescriptor]) =>
        descriptorToJsonSchema({
          [descriptor.discriminant]: DISCRIMINANT_PRIMITIVE,
          ...branchDescriptor,
        })
      ),
    };
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const key in descriptor) {
    const field = (descriptor as ObjectDescriptor)[key]!;
    properties[key] = descriptorValueToJsonSchema(field);
    if (isDescriptorValueRequired(field)) required.push(key);
  }

  const jsonSchema: Extract<JsonSchema, { type: "object"; }> = { type: "object", properties };
  if (required.length > 0) jsonSchema.required = required;
  return jsonSchema;
}
