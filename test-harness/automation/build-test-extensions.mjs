// mock extension variants so no macOS helper or real PIN is needed, output to .builds/
// each one is a full build with the mock client bundled in; release builds (dist/) leave it out

import { readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildExtension } from "../../scripts/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, ".builds");

const KINDS = ["unlocked", "multi", "locked", "pinflow", "otp", "many", "empty", "nohelper", "passkeys"];

await rm(OUT, { recursive: true, force: true });
for (const kind of KINDS) {
  const dst = join(OUT, kind);
  await buildExtension({ out: dst, mockKind: kind, quiet: true });
  if (kind === "passkeys") {
    // the test copy holds the permission up front; the release build asks for it from the options page
    const file = join(dst, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.permissions = [...new Set([...(manifest.permissions || []), "webAuthenticationProxy"])];
    delete manifest.optional_permissions;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`built ${kind} -> ${dst}`);
}
console.log("\nDone. Test builds are in test-harness/automation/.builds/");
