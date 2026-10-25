// release check shared by the one-click update: an Ed25519 signature from the maintainer's pinned key
// plus the SHA-256 GitHub reports for the asset. pure functions, no chrome APIs.

// raw Ed25519 public key (base64) of the maintainer release signing key
export const PUBLIC_KEY_B64 = "sccY06ba0IpGgg5+x6XPsY10TBdARZVzTAeQQCDmaEY=";

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

// "sha256:<hex>" from the release asset JSON, or null
export function digestHex(digest) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/** @returns {Promise<boolean>} true only when the signature and the digest both match */
export async function verifyRelease(zipBytes, sigBytes, expectedSha256Hex, publicKeyB64 = PUBLIC_KEY_B64) {
  try {
    const want = digestHex(`sha256:${expectedSha256Hex}`);
    if (!publicKeyB64 || !want) return false;
    const zip = new Uint8Array(zipBytes);
    const sig = new Uint8Array(sigBytes);
    if (sig.length !== 64) return false;
    if (toHex(await crypto.subtle.digest("SHA-256", zip)) !== want) return false;
    const key = await crypto.subtle.importKey("raw", fromB64(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, zip);
  } catch {
    return false;
  }
}
