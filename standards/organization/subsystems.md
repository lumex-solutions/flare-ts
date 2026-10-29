---
title: Subsystems
description: What earns a folder, where runtime-specific modules live, where operations modules sit, and how files inside a folder are named.
---

# Subsystems

The detail behind principle 2 of [organization](organization.md). Folders are subsystems. A folder exists for exactly one reason: a cohesive concern spanning two or more modules (its producer, its operations, its declarations). A one-module concern is a file at its layer root; it earns a folder only when it grows a second module, and the folder is named for the concern. No folders by kind (`utils/`, `helpers/`): kinds are file shapes ([file kinds](file-kinds.md)), concerns are folders.

## Runtime-specific modules live under runtime/

A subsystem's root holds only portable concerns. Modules specific to one runtime live under `runtime/<runtime>/` inside the subsystem, one folder per runtime, named for the runtime. A runtime variant of a root concern extends the portable module; it never sits beside it.

## Placement follows the data, not the caller

An operations module lives in the subsystem folder of the data it operates on, next to that data's producer and declarations; consumers import across the subsystem boundary. Operations over a compiled pipeline live beside the module that builds pipelines; the drivers that run a pipeline are its consumers and stay outside.

## A subsystem owns its declarations

Its vocabulary module lives inside its folder. A layer-root `types/` folder holds only shapes belonging to no subsystem; when everything in it belongs to one subsystem, it dissolves into that subsystem's folder.

## No prefixes inside a folder

Files inside a subsystem folder are not prefixed with the immediate folder's own name (`pipeline/build.ts`, never `pipeline/pipeline-build.ts`); the folder is the context. Prefixes spelling other context, such as an arc's `ws-`, are governed by the class-kebab rule in [file kinds](file-kinds.md), not banned here.

## The shape

```text
<subsystem>/
  <concern>.ts          a one-module concern: a class, operations, or declarations module
  types.ts | types/     vocabulary the subsystem's modules share, when no one module owns it
  <concern>/            a concern of two or more modules: its producer, operations, declarations
  runtime/<runtime>/    modules specific to one runtime, extending the portable ones
```

The shape is the rule. Which subsystems exist is what the tree says on the day.
