// Read passkeys out of an export file: Bitwarden JSON (items[].login.fido2Credentials[]) or
// Credential Exchange JSON (accounts[].items[].credentials[] with type "passkey").
// Returns { records, skipped: [{ label, reason }] }. Only P-256 (ES256) keys can be kept.

import { b64u, makeRecord, unb64u } from "./record.js";

async function p256Key(keyB64u) {
  try {
    const key = await crypto.subtle.importKey("pkcs8", unb64u(keyB64u), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    return b64u(await crypto.subtle.exportKey("pkcs8", key));
  } catch {
    return null;
  }
}

// A Bitwarden credential id is a GUID, or "b64." plus base64url of the raw id.
function bitwardenCredentialId(id) {
  if (typeof id !== "string") return null;
  if (id.startsWith("b64.")) return id.slice(4) || null;
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex) || id.length !== 36) return null;
  return b64u(Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16)));
}

const label = (rpId, userName) => [rpId || "(no site)", userName].filter(Boolean).join(" · ");

async function toRecord(f, out) {
  const name = label(f.rpId, f.userName);
  if (!f.rpId) return out.skipped.push({ label: name, reason: "missing site (rpId)" });
  if (!f.credentialId) return out.skipped.push({ label: name, reason: "missing or invalid credential id" });
  if (!f.keyValue) return out.skipped.push({ label: name, reason: "missing key" });
  if (f.keyAlgorithm !== undefined && (f.keyAlgorithm !== "ECDSA" || f.keyCurve !== "P-256")) {
    return out.skipped.push({ label: name, reason: "not a P-256 (ES256) key" });
  }
  const key = await p256Key(f.keyValue);
  if (!key) return out.skipped.push({ label: name, reason: "not a P-256 key" });
  out.records.push(makeRecord({ rpId: f.rpId, credentialId: f.credentialId, userHandle: f.userHandle || "", userName: f.userName || "", key }));
}

export async function parseBitwarden(data) {
  const out = { records: [], skipped: [] };
  if (data.encrypted) {
    out.skipped.push({ label: "(whole file)", reason: "encrypted export; export as unencrypted .json" });
    return out;
  }
  for (const item of data.items || []) {
    for (const c of item?.login?.fido2Credentials || []) {
      await toRecord(
        { rpId: c.rpId, userName: c.userName, userHandle: c.userHandle, keyValue: c.keyValue, keyAlgorithm: c.keyAlgorithm || "", keyCurve: c.keyCurve || "", credentialId: bitwardenCredentialId(c.credentialId) },
        out,
      );
    }
  }
  return out;
}

export async function parseCxf(data) {
  const out = { records: [], skipped: [] };
  for (const account of data.accounts || []) {
    for (const item of account?.items || []) {
      for (const c of item?.credentials || []) {
        if (c?.type !== "passkey") continue;
        await toRecord({ rpId: c.rpId, userName: c.username, userHandle: c.userHandle, keyValue: c.key, credentialId: c.credentialId }, out);
      }
    }
  }
  return out;
}

/** Parse the text of an export file. Throws an Error with a plain message when it is not a known format. */
export async function parseExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file is not JSON.");
  }
  if (Array.isArray(data?.accounts)) return parseCxf(data);
  if (Array.isArray(data?.items) || data?.encrypted) return parseBitwarden(data);
  throw new Error("This is not a Bitwarden or Credential Exchange export.");
}
