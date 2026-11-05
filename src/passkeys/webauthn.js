// WebAuthn answers for chrome.webAuthenticationProxy: ES256 only, no attestation, signCount 0.
// The extension builds clientDataJSON itself; the browser passes it through and the page checks the origin.

import { b64u, makeRecord, unb64u } from "./record.js";

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

const te = new TextEncoder();

/** @typedef {any} WebAuthnDetails parsed requestDetailsJson from the browser; shape is the WebAuthn request */

/**
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
export function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Small CBOR writer: unsigned and negative ints, byte strings, text strings, maps.
/**
 * @param {number} major
 * @param {number} n
 * @returns {Uint8Array}
 */
function head(major, n) {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
/**
 * @param {unknown} v
 * @returns {Uint8Array}
 */
export function cbor(v) {
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (typeof v === "string") {
    const b = te.encode(v);
    return cat(head(3, b.length), b);
  }
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  throw new Error("cbor: unsupported value");
}

/**
 * An error in the shape completeCreateRequest / completeGetRequest take.
 * @param {string} name
 * @param {string} message
 */
export function requestError(name, message) {
  return { name, message };
}

/** @param {Uint8Array} data */
async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", /** @type {BufferSource} */ (data)));
}

/**
 * WebCrypto signs ECDSA as r||s (64 bytes); WebAuthn wants ASN.1 DER.
 * @param {Uint8Array} sig
 */
export function rawToDer(sig) {
  /** @param {Uint8Array} x */
  const int = (x) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    x = x.slice(i);
    if (x[0] & 0x80) x = cat(Uint8Array.of(0), x);
    return cat(Uint8Array.of(2, x.length), x);
  };
  const r = int(sig.slice(0, 32));
  const s = int(sig.slice(32));
  return cat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

/**
 * The browser checks the page's origin against the rp id; this is the extension's own check.
 * @param {string | undefined} rpId
 * @param {string | undefined} origin
 */
export function rpIdMatchesOrigin(rpId, origin) {
  if (!rpId || !origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === rpId || host.endsWith("." + rpId);
  } catch {
    return false;
  }
}

/**
 * @param {string} type
 * @param {WebAuthnDetails} details
 * @param {string} origin
 */
function clientData(type, details, origin) {
  return te.encode(JSON.stringify({ type, challenge: details.challenge, origin, crossOrigin: false }));
}

/**
 * @param {string} rpId
 * @param {number} flags
 * @param {Uint8Array} [attested]
 */
async function authData(rpId, flags, attested) {
  return cat(await sha256(te.encode(rpId)), Uint8Array.of(flags), new Uint8Array(4), attested || new Uint8Array(0));
}

/** @param {WebAuthnDetails} details */
function originOf(details) {
  return details?.extensions?.remoteDesktopClientOverride?.origin;
}

/**
 * Everything a create request needs from its details; throws a requestError.
 * @param {WebAuthnDetails} details
 */
export function checkCreate(details) {
  const origin = originOf(details);
  const rpId = details?.rp?.id;
  if (!rpIdMatchesOrigin(rpId, origin)) throw requestError("SecurityError", "The relying party ID does not match the page origin");
  if (!(details.pubKeyCredParams || []).some((/** @type {any} */ p) => p.alg === -7)) throw requestError("NotSupportedError", "PassBridge passkeys support ES256 only");
  return { origin, rpId };
}

/**
 * Make a new passkey. Returns { record, responseJson } for the caller to store, then answer with.
 * userVerified is false for a create: nothing in the vault is read, so no user verification happened.
 * @param {WebAuthnDetails} details
 * @param {{ userVerified?: boolean }} [opts]
 */
export async function createPasskey(details, { userVerified = false } = {}) {
  const { origin, rpId } = checkCreate(details);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const id = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = b64u(id);
  const cose = cbor(new Map(/** @type {[number, number | Uint8Array][]} */ ([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33, 65)]])));
  const attested = cat(new Uint8Array(16), Uint8Array.of(id.length >> 8, id.length & 255), id, cose);
  const flags = UP | BE | BS | AT | (userVerified ? UV : 0);
  const ad = await authData(rpId, flags, attested);
  const attestationObject = cbor(new Map(/** @type {[string, string | Map<any, any> | Uint8Array][]} */ ([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]])));
  const response = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: b64u(clientData("webauthn.create", details, origin)),
      attestationObject: b64u(attestationObject),
      transports: ["internal"],
      publicKeyAlgorithm: -7,
      publicKey: b64u(spki),
      authenticatorData: b64u(ad),
    },
    clientExtensionResults: {},
  };
  const record = makeRecord({
    rpId,
    credentialId,
    userHandle: details.user?.id || "",
    userName: details.user?.name || "",
    key: b64u(pkcs8),
  });
  return { record, responseJson: JSON.stringify(response) };
}

/**
 * Checks a get request's origin and rp id; returns { origin, rpId } or throws a requestError.
 * @param {WebAuthnDetails} details
 */
export function checkGet(details) {
  const origin = originOf(details);
  const rpId = details?.rpId;
  if (!rpIdMatchesOrigin(rpId, origin)) throw requestError("SecurityError", "The relying party ID does not match the page origin");
  return { origin, rpId };
}

/**
 * True when the request allows this record (an empty allow list allows every credential of the rp).
 * @param {WebAuthnDetails} details
 * @param {import("./record.js").PasskeyRecord} record
 */
export function allowsRecord(details, record) {
  const allow = details?.allowCredentials || [];
  return record.rpId === details?.rpId && (!allow.length || allow.some((/** @type {any} */ c) => c.id === record.credentialId));
}

/**
 * Sign a get request with a stored record. userVerified sets the UV flag. Returns the response JSON.
 * @param {WebAuthnDetails} details
 * @param {import("./record.js").PasskeyRecord} record
 * @param {{ userVerified?: boolean }} [opts]
 */
export async function signAssertion(details, record, { userVerified = false } = {}) {
  const { origin, rpId } = checkGet(details);
  if (!allowsRecord(details, record)) throw requestError("NotAllowedError", "No matching passkey");
  const key = await crypto.subtle.importKey("pkcs8", unb64u(record.key), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const ad = await authData(rpId, UP | BE | BS | (userVerified ? UV : 0));
  const cdj = clientData("webauthn.get", details, origin);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, /** @type {BufferSource} */ (cat(ad, await sha256(cdj)))));
  const response = {
    id: record.credentialId,
    rawId: record.credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: b64u(cdj),
      authenticatorData: b64u(ad),
      signature: b64u(rawToDer(sig)),
      ...(record.userHandle ? { userHandle: record.userHandle } : {}),
    },
    clientExtensionResults: {},
  };
  return JSON.stringify(response);
}
