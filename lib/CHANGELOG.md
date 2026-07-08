# @flare-ts/lib

## 0.3.0

### Breaking

- The `Serializer` type on `@flare-ts/lib/schema` is renamed to `SchemaSerializer`,
  with no alias. Only the type name changes; `compileSerializer` and the compiled
  functions it returns are unchanged.

### Internal

- Restructured the schema subsystem: the `internal/` and `json/` folders dissolved
  (parsers live at `schema/parser/`, the serializer at `schema/serializer.ts`), the
  token brands and inference types moved beside the `SchemaToken` contract in
  `schema.ts`, the compiled-serializer symbol moved beside the model seam it keys,
  and a dead internal barrel was deleted. External access to the serializer seam is
  unchanged (the well-known `Symbol.for` keys are stable). Behavior-preserving.

## 0.2.0

### Minor Changes

- f3f8110: Added email and url schema primitives.
