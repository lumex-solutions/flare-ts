# @flare-ts/lib

## 0.3.0

### Breaking

- The `Serializer` type on `@flare-ts/lib/schema` is renamed to `SchemaSerializer`,
  with no alias. Only the type name changes; `compileSerializer` and the compiled
  functions it returns are unchanged.

### Fixed

- Calling an `array(...)` primitive with a pre-split string array now type-checks.
  The parser always accepted `string | string[]` at runtime, but its declared type
  (`TypedPrimitive<T[]>`) was string-only; `array()` now returns the
  `ArrayTypedPrimitive<T>` shape that spells both calling conventions.

- `toJsonSchema()`'s declared return type now includes the `minLength`/`maxLength`/
  `pattern` fields it emits for constrained `str`/`text` primitives; previously
  reading them off the result required a cast.

- `optional(array(...))` and `defaultTo([], array(...))` now keep the array's
  `string | string[]` calling convention at the type level (the parsers always
  accepted both at runtime). `optional(array(...))` returns the new
  `OptionalArrayTypedPrimitive` shape.

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
