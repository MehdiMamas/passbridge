// ported from au2001/icloud-passwords-firefox (Apache-2.0) to browser APIs, see NOTICE

/**
 * @param {string} hex
 */
export function hexToBytes(hex) {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * @param {string} b64
 */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * @param {string} str
 */
export function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/**
 * @param {...Uint8Array} arrays
 */
export function concatBytes(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * @param {bigint} n
 */
export function bigIntToBytes(n) {
  if (n === 0n) return new Uint8Array([0]);
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array(out);
}

/**
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
export function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} length
 */
export function padBytes(bytes, length) {
  if (bytes.length >= length) return bytes.slice(bytes.length - length);
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * @param {...(Uint8Array | string | number)} inputs
 */
export async function sha256(...inputs) {
  const data = concatBytes(...inputs.map((i) => (i instanceof Uint8Array ? i : utf8ToBytes(String(i)))));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/**
 * @param {number} count
 */
export function randomBytes(count) {
  const a = new Uint8Array(count);
  crypto.getRandomValues(a);
  return a;
}

/**
 * @param {bigint} a
 * @param {bigint} n
 * @returns {bigint}
 */
export function mod(a, n) {
  a %= n;
  if (a < 0n) a += n;
  return a;
}

/**
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} n
 * @returns {bigint}
 */
export function powmod(base, exp, n) {
  if (exp < 0n) throw new Error("negative exponent unsupported");
  base = mod(base, n);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, n);
    base = mod(base * base, n);
    exp >>= 1n;
  }
  return result;
}

export const QueryStatus = {
  Success: 0,
  GenericError: 1,
  InvalidParam: 2,
  NoResults: 3,
  FailedToDelete: 4,
  FailedToUpdate: 5,
  InvalidMessageFormat: 6,
  DuplicateItem: 7,
  UnknownAction: 8,
  InvalidSession: 9,
};

/**
 * @param {number} status
 */
export function queryStatusError(status) {
  /** @type {Record<number, string>} */
  const map = {
    1: "Generic query error",
    2: "Invalid query param",
    3: "No query results",
    4: "Failed to delete",
    5: "Failed to update",
    6: "Invalid message format",
    7: "Duplicate item",
    8: "Unknown action",
    9: "Invalid session",
  };
  return new Error(map[status] ?? `Query error: status ${status}`);
}
