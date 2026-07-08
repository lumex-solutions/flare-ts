---
name: flare-organization
description: Review ONE flare file or small folder against the flare organization standards (file kinds, declaration placement, subsystem shape, naming). Use when authoring a flare module (run before finishing), or when the user asks to review the structure of a specific path. Not for repo-wide sweeps.
---

# flare-organization

Audit one file (or one small folder) against the four organization standards, report findings with
line references, and apply fixes when asked.

## Input

A target path is required: one `.ts` file, or a folder. For a folder, collect the `.ts` files
under it; if that is more than ~20 files, stop and tell the user this skill is scoped to a single
module or subsystem, and ask them to narrow the target. Never expand scope beyond the target.

## Rules source

Read all five standards before auditing (paths from the repo root):

1. `standards/style/organization/file-kinds.md`
2. `standards/style/organization/subsystems.md`
3. `standards/style/organization/declarations.md`
4. `standards/style/organization/naming.md`
5. `standards/style/api/surface.md`

The standards are the only rules. Do not import preferences from elsewhere.

## Procedure

For each target file, three passes (plus a folder pass when the target is a folder):

1. **File kind** - classify the file (class / operations / declarations module) from its exports.
   Mixed exports are violations (a second exported class, an exported function in a class or
   declarations module beyond the own-vocabulary factory exception). Check the filename matches
   the kind rule. Check in-file ordering and the subordination rule (no imports of another file's
   subordinate helpers).
2. **Declaration placement** - each exported declaration against its kind's rules: signature type
   vs vocabulary for types; implementer-existence and consumer-side home for interfaces; domain
   home for exported constants; key-owner home for unique symbols; state-access rule for methods
   vs module functions vs statics. A borderline signature-vs-vocabulary call is reported as
   `decision`, not `violation`.
3. **Naming** - the `I*` interface prefix (implementations named for their job, not the
   interface), the audience tiers, class-kebab filenames minus path-spelled leading segments (per file-kinds.md). When a name looks off, cite the nearest
   existing family it should reconcile against.
4. **Folder pass** (folder targets only) - subsystem shape: files prefixed with the folder name,
   a layer-root `types/` whose contents all belong to one subsystem (dissolution candidate,
   `decision`), a concern that has grown a second module without earning a folder (`decision`),
   an operations module living with its callers instead of its data.

## Report

One findings table, ordered by file then line:

| Location     | Rule                      | Severity  | Finding                              |
| ------------ | ------------------------- | --------- | ------------------------------------ |
| `path.ts:12` | file-kinds / class module | violation | Exports a function beside the class. |

Severities: **violation** (breaks a stated rule), **missing** (something the rules require is
absent), **suggestion** (compliant but a clearer placement or name applies), **decision** (the
standard defers to a developer ruling - borderline signature-vs-vocabulary, subsystem-folder
promotion, `types/` dissolution; surfaced, never auto-fixed). After the table, one verdict line:
file count, finding count by severity. Zero findings is reported plainly as a pass.

## Fix mode

Apply fixes only when asked (or when you are the author finishing a module). Constraints:

- Structure only: moves, splits, renames, and re-exports. Never change runtime behavior.
- A move or rename updates every importer in the same pass, and the fix is not done until
  typecheck and lint pass.
- Never act on a `decision` finding without an explicit ruling from the developer.
- After fixing, re-run the audit passes on the touched files and report the remaining findings.
