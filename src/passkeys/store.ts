// Passkeys in the vault: list, read and save through the client (src/session/create-client.js).
// Each passkey is one login for PASSKEY_URL; see record.ts for the username and password formats.

import { confirmLoginAdded, countLogins } from "../session/add-login-check.js";
import { PASSKEY_HOST, PASSKEY_URL, decodeRecord, encodeRecord, parseUsername, recordUsername } from "./record.ts";

/** @typedef {{ username: string, sites: any[], rpId: string, userName: string, idPrefix: string }} PasskeyName */

/**
 * Passkey names in the vault: [{ username, sites, rpId, userName, idPrefix }].
 * @param {any} client
 * @param {number} tabId
 * @returns {Promise<PasskeyName[]>}
 */
export async function listPasskeys(client, tabId) {
  const names = await client.getLoginNamesForURL(tabId, PASSKEY_URL);
  /** @type {PasskeyName[]} */
  const out = [];
  for (const n of names || []) {
    const parsed = parseUsername(n.username);
    if (parsed) out.push({ username: n.username, sites: n.sites || [], ...parsed });
  }
  return out;
}

/**
 * The names that can answer for a page host: the rp id is the host or a parent domain of it.
 * @param {PasskeyName[]} list
 * @param {string} host
 */
export function passkeysForHost(list, host) {
  return list.filter((p) => host === p.rpId || host.endsWith("." + p.rpId));
}

/**
 * Read one passkey's record. The helper may ask for Windows Hello first, so this can take as long
 * as the request allows. Returns { record, userVerified } or null. The record is not cached.
 * @param {any} client
 * @param {number} tabId
 * @param {{ username: string, sites?: any[] }} entry
 * @returns {Promise<{ record: import("./record.ts").PasskeyRecord, userVerified: boolean } | null>}
 */
export async function readPasskey(client, tabId, entry) {
  const cred = await client.getPasswordForLoginName(tabId, PASSKEY_URL, { username: entry.username }, PASSKEY_HOST, entry.sites?.[0] || PASSKEY_HOST);
  const record = cred?.password ? decodeRecord(cred.password) : null;
  if (!record) return null;
  // the reply only says so when the helper verified the user; the usual reply carries nothing
  return { record, userVerified: cred.verified === true };
}

/**
 * Save a record, then wait until the vault lists it. Returns "saved", "exists" (same name already
 * in the vault, nothing written), "locked" or "timeout".
 * @param {any} client
 * @param {number} tabId
 * @param {import("./record.ts").PasskeyRecord} record
 * @param {object} [opts] extra options for confirmLoginAdded
 * @returns {Promise<"saved" | "exists" | "locked" | "timeout">}
 */
export async function savePasskey(client, tabId, record, opts = {}) {
  const username = recordUsername(record);
  const lookup = () => client.getLoginNamesForURL(tabId, PASSKEY_URL);
  // the same credential id is the same passkey; two passkeys of one user on one site are two logins
  const names = await lookup();
  const prefix = record.credentialId.slice(0, 8);
  for (const n of (names || []).map((/** @type {any} */ n) => ({ username: n.username, sites: n.sites || [], ...parseUsername(n.username) }))) {
    if (n.rpId !== record.rpId || n.idPrefix !== prefix) continue;
    const read = await readPasskey(client, tabId, n);
    if (read?.record.credentialId === record.credentialId) return "exists";
  }
  const before = countLogins(names, username);
  await client.saveLogin(tabId, PASSKEY_URL, username, encodeRecord(record));
  return confirmLoginAdded({ lookup, username, before, isReady: () => client.ready, ...opts });
}
