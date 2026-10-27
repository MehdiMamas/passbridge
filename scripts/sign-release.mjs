// release signing for the one-click update. the private key lives in the maintainer's macOS Keychain, never on GitHub.
//   node scripts/sign-release.mjs sign <any.zip> [--key <pem file>] [--pub <base64 raw public key>]
// any zip name works: passbridge.zip and both helper zips are signed the same way, each release uploads all three .sig files.
// --pub checks against another public key than the pinned one (tests with a throwaway key only)
// writes <zip>.sig (raw 64-byte Ed25519 signature) and checks it against the key pinned in src/update/verify.js.
import { createPrivateKey, sign, verify, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { PUBLIC_KEY_B64 } from "../src/update/verify.js";

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
const keyFile = keyFlag >= 0 ? args.splice(keyFlag, 2)[1] : null;
const pubFlag = args.indexOf("--pub");
const pubOverride = pubFlag >= 0 ? args.splice(pubFlag, 2)[1] : null;
const [cmd, zip] = args;

if (cmd !== "sign" || !zip || (keyFlag >= 0 && !keyFile) || (pubFlag >= 0 && !pubOverride)) {
  console.error("usage: sign-release.mjs sign <zip> [--key <pem file>] [--pub <base64>]");
  process.exit(2);
}

// the Keychain item holds the PKCS8 PEM, base64 encoded on one line
function loadKey() {
  if (keyFile) return readFileSync(keyFile);
  const out = execFileSync("security", ["find-generic-password", "-a", "passbridge", "-s", "passbridge-release-signing", "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return Buffer.from(out.trim(), "base64");
}

try {
  const key = createPrivateKey(loadKey());
  const data = readFileSync(zip);
  const sig = sign(null, data, key);
  const raw = Buffer.from(pubOverride ?? PUBLIC_KEY_B64, "base64");
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  if (!verify(null, data, pub, sig)) throw new Error("the signature does not match the key pinned in src/update/verify.js");
  writeFileSync(`${zip}.sig`, sig);
  console.log(`wrote ${zip}.sig (${sig.length} bytes), verified against the pinned key`);
} catch (e) {
  console.error(`signing failed: ${e.message.split("\n")[0]}`);
  process.exit(1);
}
