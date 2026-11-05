// Most recently used login order per site, kept in chrome.storage.local across restarts.
// Nothing readable is stored: sites and usernames are HMAC-SHA-256 values under a random
// per-install key, so the order is useless without that key.
import { registrableDomain } from "./site-domain.js";

const ORDER_KEY = "mru:v1";
const SECRET_KEY = "mru:key";
const MAX_USERS = 20;
const MAX_SITES = 500;

const enc = new TextEncoder();
let keyPromise;
let writeChain = Promise.resolve();

/** @param {ArrayBuffer | Uint8Array} buf */
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
/** @param {string} hex */
const fromHex = (hex) => Uint8Array.from(/** @type {string[]} */ (hex.match(/../g)), (h) => parseInt(h, 16));

async function loadOrCreateKey() {
  const store = chrome.storage.local;
  let hex = (await store.get(SECRET_KEY))[SECRET_KEY];
  if (!hex) {
    const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
    // write only if nothing appeared since the read, then re-read so every caller agrees
    if (!(await store.get(SECRET_KEY))[SECRET_KEY]) await store.set({ [SECRET_KEY]: fresh });
    hex = (await store.get(SECRET_KEY))[SECRET_KEY];
  }
  return crypto.subtle.importKey("raw", fromHex(/** @type {string} */ (hex)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** @param {string} text */
async function mac(text) {
  keyPromise ??= loadOrCreateKey().catch((e) => {
    keyPromise = undefined;
    throw e;
  });
  return toHex(await crypto.subtle.sign("HMAC", await keyPromise, enc.encode(text)));
}

/** @param {string | null | undefined} host */
const siteId = (host) => mac("site:" + (registrableDomain(host) || ""));
/** @param {unknown} username */
const userId = (username) => mac("user:" + String(username).toLowerCase());

/** @returns {Promise<[string, string[]][]>} */
async function readOrder() {
  const v = (await chrome.storage.local.get(ORDER_KEY))[ORDER_KEY];
  return Array.isArray(v) ? v : [];
}

/**
 * sites most recent first: [[siteHash, [userHash, ...]], ...]
 * @param {string | null | undefined} host
 * @param {unknown} username
 * @returns {Promise<void>}
 */
export function recordUse(host, username) {
  if (!host || !username) return Promise.resolve();
  const run = async () => {
    const [site, user] = await Promise.all([siteId(host), userId(username)]);
    const sites = await readOrder();
    const prev = sites.find(([s]) => s === site);
    const users = [user, ...(prev ? prev[1].filter((u) => u !== user) : [])].slice(0, MAX_USERS);
    const next = [[site, users], ...sites.filter(([s]) => s !== site)].slice(0, MAX_SITES);
    await chrome.storage.local.set({ [ORDER_KEY]: next });
  };
  const p = writeChain.then(run);
  writeChain = p.catch(() => {});
  return p;
}

/**
 * @template {{ username?: string }} T
 * @param {string | null | undefined} host
 * @param {T[]} logins
 * @returns {Promise<T[]>}
 */
export async function orderByUse(host, logins) {
  try {
    if (!host || logins.length < 2) return logins;
    const site = await siteId(host);
    const entry = (await readOrder()).find(([s]) => s === site);
    if (!entry) return logins;
    const ids = await Promise.all(logins.map((l) => userId(l.username || "")));
    /** @param {number} i */
    const rank = (i) => {
      const r = entry[1].indexOf(ids[i]);
      return r === -1 ? Infinity : r;
    };
    return logins
      .map((l, i) => ({ l, i, r: rank(i) }))
      .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r < b.r ? -1 : 1))
      .map((x) => x.l);
  } catch {
    return logins;
  }
}
