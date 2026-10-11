// mock extension variants so no macOS helper or real PIN is needed, output to .builds/
// each one is a full build with the mock client bundled in; release builds (dist/) leave it out

import { rm } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildExtension } from "../../scripts/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, ".builds");

const KINDS = ["unlocked", "multi", "locked", "pinflow", "otp", "many"];

await rm(OUT, { recursive: true, force: true });
for (const kind of KINDS) {
  const dst = join(OUT, kind);
  await buildExtension({ out: dst, mockKind: kind, quiet: true });
  console.log(`built ${kind} -> ${dst}`);
}
console.log("\nDone. Test builds are in test-harness/automation/.builds/");
