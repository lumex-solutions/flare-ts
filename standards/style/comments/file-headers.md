# File headers

Every `src/` file opens with a file-header JSDoc block: the first thing in the file, before
imports (see the ordering rule in [file-kinds.md](../organization/file-kinds.md)). No
exemptions and no "non-trivial" judgment call - a file either has its header or it is wrong.
The reader (human or agent) orients from line 1, before any imports scroll the purpose out of
view.

## Size: a signpost, never the map

Minimum one sentence; maximum a short paragraph (three or four sentences). A header states what
the file is and where it sits, then stops. It never explains the surrounding system: system-level
narrative in a header is prose no edit is forced to touch, so it drifts and goes stale while the
code moves on.

When ambiguity remains after a one-paragraph header, the verbosity goes DOWN into the symbol
JSDoc, not up into the header: the class, function, or type that owns the subtlety carries the
detailed body (see [jsdoc.md](jsdoc.md)). Symbol docs sit on the thing being edited, so they are
maintained under review pressure; headers are not.

**Exception, by decision only:** a genuinely complex file may exceed the ceiling when the extra
header context is truly necessary and cannot be pushed down. That call belongs to a developer,
never to an automated check: tooling and agents SURFACE an over-length header for review, and a
developer decides whether it stays. Expect this to be rare; the default is short.

## What the header says, by file kind

- **Class module** - one line: what the class is and its role in the subsystem. Design rationale
  lives on the class JSDoc, never duplicated up into the header.
- **Operations module** - the concern: what phase or lifecycle these functions implement, and who
  consumes them. Per-function detail lives on the functions.
- **Declarations module** - what domain the vocabulary describes.

`{@link}` pointers to the one or two sibling seams a reader needs next are welcome (cheap,
low-drift). A hard constraint the whole file depends on (runtime target, platform assumption,
call-order requirement) may take one sentence.

Examples:

```ts
/**
 * The WebSocket arc, exposed as `host.ws`: the {@link WebSocketBase} authoring surface plus
 * compile and per-upgrade execution. Mirrors {@link HttpArc}.
 */
```

```ts
/** Subprotocol negotiation for the WebSocket handshake (RFC 6455 section 1.9). */
```

## What a header never contains

- **System or architecture narrative.** If it takes paragraphs, it belongs on the symbols that
  own it, or in a standards/architecture document - not at the top of a source file.
- **Change history or plan-relative language.** No "replaces X", "unchanged from", task, plan,
  session, or branch references. Version control owns history; the header describes the present.
- **An export inventory.** The file already says what it exports.
- **Implementation walkthroughs.** How a function works belongs in inline comments next to the
  code.
- **Speculation.** Future variants and unimplemented behavior are not documented; silence is
  correct.
