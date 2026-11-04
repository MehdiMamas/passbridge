// The stored form of one passkey. Each passkey is one login in the vault under PASSKEY_URL:
// username "<rpId> · <user name> · <first 8 of the credential id>", password = base64url of the record JSON.

export const PASSKEY_URL = "https://passkeys.passbridge.invalid/";
export const PASSKEY_HOST = "passkeys.passbridge.invalid";
export const RECORD_VERSION = 1;

const SEP = " · ";

export function b64u(bytes) {
  let s = "";
  for (const c of new Uint8Array(bytes)) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** key = PKCS#8 P-256 private key, base64url; userHandle and credentialId are base64url too. */
export function makeRecord({ rpId, credentialId, userHandle = "", userName = "", key }) {
  return { v: RECORD_VERSION, rpId, credentialId, userHandle, userName, key };
}

export function encodeRecord(rec) {
  return b64u(new TextEncoder().encode(JSON.stringify(rec)));
}

/** Returns the record, or null when the text is not a record of a version this build understands. */
export function decodeRecord(text) {
  try {
    const rec = JSON.parse(new TextDecoder().decode(unb64u(text)));
    if (!rec || rec.v !== RECORD_VERSION) return null;
    for (const k of ["rpId", "credentialId", "key"]) if (typeof rec[k] !== "string" || !rec[k]) return null;
    for (const k of ["userHandle", "userName"]) if (typeof rec[k] !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

export function recordUsername(rec) {
  return [rec.rpId, rec.userName.replace(/\s+/g, " "), rec.credentialId.slice(0, 8)].join(SEP);
}

/** {rpId, userName, idPrefix} for a name made by recordUsername, else null. */
export function parseUsername(name) {
  const parts = String(name || "").split(SEP);
  if (parts.length < 3) return null;
  const idPrefix = parts[parts.length - 1];
  const rpId = parts[0];
  if (!rpId || /\s/.test(rpId) || !/^[A-Za-z0-9_-]{1,8}$/.test(idPrefix)) return null;
  return { rpId, userName: parts.slice(1, -1).join(SEP), idPrefix };
}

export function isPasskeyName(name) {
  return parseUsername(name) !== null;
}

/** True for a URL (or host) that is the dedicated passkey URL, so fill lists can drop it. */
export function isPasskeyHost(urlOrHost) {
  const s = String(urlOrHost || "");
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname === PASSKEY_HOST;
  } catch {
    return false;
  }
}

/** True for a login-list row that is a stored passkey, so fill lists never offer it as a password. */
export function isPasskeyLogin(login) {
  return isPasskeyName(login?.username) || (Array.isArray(login?.sites) && login.sites.some(isPasskeyHost));
}
