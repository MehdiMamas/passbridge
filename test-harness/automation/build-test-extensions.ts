// mock extension variants so no macOS helper or real PIN is needed, output to .builds/
// each one is a full build with the mock client bundled in; release builds (dist/) leave it out

import { rm } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildExtension } from "../../scripts/build.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, ".builds");

const KINDS = ["unlocked", "multi", "locked", "pinflow", "otp", "many", "empty", "nohelper", "passkeys"];

await rm(OUT, { recursive: true, force: true });
for (const kind of KINDS) {
  const dst = join(OUT, kind);
  await buildExtension({ out: dst, mockKind: kind, quiet: true });
  console.log(`built ${kind} -> ${dst}`);
}
// e2e builds: the release client (empty mock kind), talking to the fake Apple helper. They report the
// platform of their name, so both the mac and the Windows code paths run on Linux CI.
for (const platform of ["mac", "win"]) {
  const dst = join(OUT, `real-${platform}`);
  await buildExtension({ out: dst, mockKind: "", testPlatform: platform, quiet: true });
  console.log(`built real-${platform} -> ${dst}`);
}
console.log("\nDone. Test builds are in test-harness/automation/.builds/");
