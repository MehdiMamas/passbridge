import { siteLookupHosts } from "./site-domain.js";
import { isPasskeyLogin } from "../passkeys/record.js";

// iCloud for Windows 15.10 lists only codes set up on Windows, so a synced TOTP needs a per-login read
export const OTP_FALLBACK_MAX_LOGINS = 8;

/** @param {unknown} s */
const lc = (s) => String(s ?? "").trim().toLowerCase();

// a totp row belongs to this login when the username matches, or its label is <issuer>:<login>
/**
 * @param {{ source?: string, username?: string } | null | undefined} row
 * @param {unknown} username
 * @returns {boolean}
 */
export function totpRowMatches(row, username) {
  if (!row || row.source !== "totp") return false;
  const u = lc(username);
  if (!u) return false;
  const r = lc(row.username);
  return r === u || (r.length > u.length + 1 && r.endsWith(":" + u));
}

/**
 * @param {any[] | null | undefined} rows
 * @param {unknown} username
 */
export function matchSyncedTotp(rows, username) {
  return (rows || []).find((e) => totpRowMatches(e, username)) || null;
}

/**
 * @param {any[]} base
 * @param {any[]} extra
 */
function mergeEntries(base, extra) {
  const seen = new Set(base.map((e) => `${e.source}|${lc(e.username)}|${lc(e.domain)}`));
  const out = [...base];
  for (const e of extra) {
    const key = `${e.source}|${lc(e.username)}|${lc(e.domain)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * @param {any} client
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<string[]>}
 */
async function loginNamesFor(client, tabId, url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch (_) {
    return [];
  }
  const seen = new Set();
  const usernames = [];
  for (const h of siteLookupHosts(host)) {
    const names = (await client.getLoginNamesForURL(tabId, `https://${h}/`).catch(() => [])).filter((/** @type {any} */ l) => !isPasskeyLogin(l));
    for (const n of names) {
      const k = lc(n.username);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      usernames.push(n.username);
    }
  }
  return usernames.slice(0, OTP_FALLBACK_MAX_LOGINS);
}

/**
 * @param {any} client
 * @param {{ tabId: number, frameId: number, frameUrls: string[] }} ctx
 */
async function syncedTotpEntries(client, { tabId, frameId, frameUrls }) {
  const url = frameUrls[0];
  if (!url) return [];
  const entries = [];
  for (const username of await loginNamesFor(client, tabId, url)) {
    const found = await client.readOneTimeCode(tabId, frameId, frameUrls, username).catch(() => []);
    const hit = matchSyncedTotp(found, username);
    if (hit) entries.push(hit);
  }
  return entries;
}

/**
 * listOnly skips the per-login reads (they can wait on Windows Hello and hold the helper lock)
 * @param {any} client
 * @param {{ tabId: number, frameId: number, frameUrls: string[], platform?: string, listOnly?: boolean }} ctx
 */
export async function listOtpEntries(client, { tabId, frameId, frameUrls, platform, listOnly = false }) {
  const { entries, requiresAuth } = await client.getOneTimeCodes(tabId, frameId, frameUrls);
  let merged = entries;
  if (!listOnly && platform === "win" && !entries.some((/** @type {any} */ e) => e.source === "totp")) {
    merged = mergeEntries(entries, await syncedTotpEntries(client, { tabId, frameId, frameUrls }));
  }
  return { entries: merged, requiresAuth };
}
