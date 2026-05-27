/**
 * Generates Deno type definitions.
 *
 * Usage: node scripts/gen-deno-types.mjs
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("core/src/lib/host/runtime/ref/deno.d.ts");
const output = execSync("deno types", { encoding: "utf8" });
writeFileSync(OUT, output, { encoding: "utf8" }); // Node writes UTF-8 without BOM
console.log(`Written: ${OUT}`);
