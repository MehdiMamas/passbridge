// @ts-check
// alarm keep-alive holds the MV3 worker so the PIN isnt re-prompted every idle-out

import { State, setDeviceLabel } from "./apple/protocol.js";
import { createClient } from "./session/create-client.js";
import { labelForOs } from "./apple/os-label.js";
import { SETTINGS_AREA, getSettings, hostBlocked, migrateSettingsToSync, settingsStore } from "./settings.js";
import { generateApplePassword } from "./password-generate.js";
import { otpAuthSecret, parseOtpAuth } from "./otpauth.js";
import { passwordSearchSteps } from "./session/password-search.js";
import { registrableDomain, siteLookupHosts } from "./session/site-domain.js";
import { frameUrlsFor } from "./session/frame-urls.js";
import { orderByPageUsername } from "./session/username-match.js";
import { scrubUrl } from "./report-scrub.js";
import { initAgent, pickAllowedFrames } from "./agent.js";
import { availableUpdate, checkForUpdate, dismissUpdate, takeUpdatedTo } from "./update/check.js";
import { autoInstallUpdate, installUpdate, takeAutoUpdatedTo, updaterAvailable } from "./update/install.js";
import { hasInterruptedUpdate } from "./update/files.js";
import { reinjectContentScripts } from "./reload-recovery.js";

const client = createClient();
/** @typedef {{ username: string, sites: string[], via: string }} SiteLogin */
/** @typedef {{ username: string, password: string }} Cred */

// the right-click login list, with the tab and site it was built for
/** @type {{ tabId: number | null, host: string, logins: SiteLogin[] }} */
let menuFor = { tabId: null, host: "", logins: [] };
let refreshRunning = false;
let refreshAgain = false;
let platformOs = "mac";
const platformReady = new Promise((resolve) => {
  try {
    chrome.runtime.getPlatformInfo((info) => {
      platformOs = info?.os || "mac";
      setDeviceLabel(labelForOs(platformOs));
      resolve(platformOs);
    });
  } catch (_) {
    resolve(platformOs);
  }
});

client.onStateChange((s) => {
  if (s !== State.Unlocked) {
    pwCacheClear();
    otpByTab.clear();
    dropHeldOffers();
    clearBadges();
  }
  broadcast({ type: "state", state: s });
  refreshActiveTab();
  if (s === State.Unlocked) notifyUnlocked();
});

client.onOneTimeCodeAvailable(async () => {
  try {
    const tab = await activeTab();
    if (tab?.id == null) return;
    otpByTab.delete(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: "oneTimeCodeAvailable" }).catch(() => {});
  } catch (_) {}
});

// rows resolve by id so the page never chooses the username/domain
const otpByTab = new Map();
const OTP_LIST_TTL_MS = 120_000;

// never the code itself at list time
function otpRow(e, i) {
  return { id: i, source: e.source, username: e.username, domain: e.domain };
}

// iCloud for Windows 15.10 lists only codes set up on Windows, so a synced TOTP needs a per-login read
const OTP_FALLBACK_MAX_LOGINS = 8;

async function syncedTotpEntries(tabId, frameId, frameUrls) {
  const url = frameUrls[0];
  if (!url) return [];
  const names = await client.getLoginNamesForURL(tabId, url).catch(() => []);
  const usernames = [...new Set(names.map((n) => n.username).filter(Boolean))].slice(0, OTP_FALLBACK_MAX_LOGINS);
  const entries = [];
  for (const username of usernames) {
    const found = await client.readOneTimeCode(tabId, frameId, frameUrls, username).catch(() => []);
    const hit = found.find((e) => e.source === "totp" && e.username === username);
    if (hit) entries.push(hit);
  }
  return entries;
}

async function listOneTimeCodes(tabId, frameId, frameUrls) {
  let { entries, requiresAuth } = await client.getOneTimeCodes(tabId, frameId, frameUrls);
  if (!entries.length && (await platformReady) === "win") entries = await syncedTotpEntries(tabId, frameId, frameUrls);
  otpByTab.set(tabId, { at: Date.now(), entries, frameId, frameUrls });
  return { rows: entries.map(otpRow), requiresAuth };
}

// TOTP is re-read now, the value rotates and this read triggers Touch ID when the vault demands it
async function resolveOneTimeCode(tabId, id) {
  const cached = otpByTab.get(tabId);
  if (!cached || Date.now() - cached.at > OTP_LIST_TTL_MS) throw new Error("code list expired, focus the field again");
  const entry = cached.entries[id];
  if (!entry) throw new Error("unknown code");
  if (entry.source !== "totp") return entry.code;
  const fresh = await client.readOneTimeCode(tabId, cached.frameId, cached.frameUrls, entry.username);
  const match =
    fresh.find((e) => e.source === "totp" && e.username === entry.username && e.domain === entry.domain) ||
    fresh.find((e) => e.source === "totp");
  if (!match?.code) throw new Error("no code returned");
  return match.code;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const mruByHost = new Map();
function recordMru(host, username) {
  if (!host || !username) return;
  const u = username.toLowerCase();
  const arr = (mruByHost.get(host) || []).filter((x) => x !== u);
  arr.unshift(u);
  mruByHost.set(host, arr.slice(0, 10));
}
function orderByMru(host, logins) {
  const order = mruByHost.get(host);
  if (!order || !order.length) return logins;
  const rank = (u) => {
    const i = order.indexOf((u || "").toLowerCase());
    return i === -1 ? Infinity : i;
  };
  return [...logins].sort((a, b) => rank(a.username) - rank(b.username));
}

// "" lets the native sheet ask, null saves nothing
function pickSaveTarget({ host, existing, detected, generated, newPwCtx }) {
  const matched = detected && existing.find((u) => u.toLowerCase() === detected.toLowerCase());
  // update only on a new password, stay quiet on a plain re-login
  if (matched) return generated || newPwCtx ? matched : null;
  if (detected) return detected;
  // attach to the MRU account, apple's sheet lets the user re-pick
  if (newPwCtx && existing.length) {
    return orderByMru(host, existing.map((u) => ({ username: u })))[0].username;
  }
  if (generated) return "";
  return null;
}

// a reset can navigate away, so stash saves that arrived while locked and flush on unlock
const pendingSaves = [];
function queuePendingSave(save) {
  const k = `${save.host} ${(save.detected || "").toLowerCase()}`;
  const i = pendingSaves.findIndex((p) => `${p.host} ${(p.detected || "").toLowerCase()}` === k);
  if (i >= 0) pendingSaves.splice(i, 1);
  pendingSaves.push({ ...save, at: Date.now() });
  while (pendingSaves.length > 10) pendingSaves.shift();
}
async function flushPendingSaves() {
  if (!client.ready || !pendingSaves.length) return;
  const batch = pendingSaves.splice(0);
  const settings = await getSettings();
  for (const s of batch) {
    try {
      if (!secretFresh(s)) continue;
      if (hostBlocked(s.host, settings.excludedDomains)) continue;
      let existing = [];
      try {
        existing = (await siteLogins(s.tabId, s.frameUrl))
          .map((l) => l.username)
          .filter(Boolean);
      } catch {}
      const target = pickSaveTarget({ ...s, existing });
      if (target === null) continue;
      const isUpdate = existing.some((u) => u.toLowerCase() === String(target).toLowerCase());
      if ((isUpdate && settings.askToUpdate === false) || (!isUpdate && settings.askToSave === false)) continue;
      await presentSaveOffer({
        tabId: s.tabId,
        frameUrl: s.frameUrl,
        target,
        password: s.password,
        host: s.host,
        update: isUpdate,
      });
    } catch {}
  }
}

// keeps internal spaces so distinct usernames arent merged
function normUsername(u) {
  return (u || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

// helper returns the same username for www + apex entries, fills look up by username so dupes are useless
function uniqueByUsername(logins) {
  const seen = new Set();
  return logins.filter((l) => {
    const k = normUsername(l.username);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function framePathUrl(frameUrl) {
  const u = new URL(frameUrl);
  u.hash = "";
  u.search = "";
  return u.href;
}

// the helper may only list the exact host. ask for the page host and each parent up to the
// site, so account.apple.com also shows apple.com logins, and remember which host found each one.
/** @returns {Promise<SiteLogin[]>} */
async function siteLogins(tabId, url) {
  const host = hostnameOf(url);
  if (!host) return [];
  /** @type {SiteLogin[]} */
  const out = [];
  const byName = new Map();
  for (const h of siteLookupHosts(host)) {
    let list;
    try {
      list = await client.getLoginNamesForURL(tabId, h === host ? url : `https://${h}/`);
    } catch (e) {
      if (h === host) throw e;
      continue;
    }
    for (const login of list || []) {
      const sites = Array.isArray(login.sites) ? login.sites : [];
      const seen = byName.get(normUsername(login.username));
      if (seen) {
        // a parent that lists it too becomes one more website to search
        for (const site of [...sites, h]) if (!seen.sites.includes(site)) seen.sites.push(site);
        continue;
      }
      const row = { username: login.username, sites: [...sites], via: h };
      byName.set(normUsername(login.username), row);
      out.push(row);
    }
  }
  return out;
}

// the page and the popup get usernames only, sites and via stay in the worker
function publicLogins(logins) {
  return logins.map((l) => ({ username: l.username }));
}

// the login is listed again here, so the hosts searched never come from the caller.
// one only a parent domain listed is searched on that domain first.
async function readPasswordForFrame(tabId, frameUrl, username) {
  const host = hostnameOf(frameUrl);
  const pathUrl = client.capabilities?.supportsSubURLs ? framePathUrl(frameUrl) : null;
  /** @type {SiteLogin | null} */
  let match = null;
  try {
    match = (await siteLogins(tabId, frameUrl)).find((l) => normUsername(l.username) === normUsername(username)) || null;
  } catch {}
  const tried = [];
  /** @type {Cred | null | undefined} */
  let cred = null;
  for (const step of passwordSearchSteps(host, match?.sites, pathUrl, match?.via)) {
    tried.push(`${step.envelope}|${step.search}`);
    cred = await client.getPasswordForLoginName(
      tabId,
      frameUrl,
      { username: match?.username ?? username },
      step.search === host ? undefined : step.search,
      step.envelope === host ? undefined : step.envelope,
    );
    if (cred?.password) break;
    cred = null;
  }
  if (!cred) console.info("[PassBridge] passwordRead", { status: "no credential", host, tried });
  else if (tried.length > 1) console.info("[PassBridge] passwordRead", { status: "ok", host, tried });
  return { cred, tried };
}

const lastFillByTab = new Map();

// re-filling the same login skips a second Touch ID, apple prompts every read
const PW_CACHE_TTL_MS = 15_000;
const SECRET_HOLD_MS = 120_000;
const pwCache = new Map();
function pwCacheKey(host, username) {
  return `${host}\n${(username || "").toLowerCase()}`;
}
function pwCacheGet(host, username) {
  const k = pwCacheKey(host, username);
  const hit = pwCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > PW_CACHE_TTL_MS) {
    pwCache.delete(k);
    return null;
  }
  return hit.cred;
}
function pwCacheSet(host, cred) {
  if (!host || !cred?.username) return;
  pwCache.set(pwCacheKey(host, cred.username), { cred, at: Date.now() });
}
function pwCacheClear() {
  pwCache.clear();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || "timed out")), ms)),
  ]);
}

// defeat the MV3 ~30s idle shutdown that kills the session
const KEEPALIVE_ALARM = "open-passwords-keepalive";
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== KEEPALIVE_ALARM) return;
  // touching an extension API resets the idle timer
  chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  sweepExpiredSecrets();
});

// every 30 minutes, checkForUpdate itself skips a request made inside UPDATE_CHECK_MS
const UPDATE_ALARM = "update-check";
chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE_ALARM) (async () => { await checkForUpdate(); await autoInstallUpdate(); })().catch(() => {});
});

async function ensureConnected() {
  if (client.state === State.Disconnected) {
    try {
      await client.connect();
    } catch (e) {
      // surfaced via state change (NoHelper / Disconnected)
    }
  }
}

chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);
// chrome leaves open pages with a dead copy of the content script after a reload or update
chrome.runtime.onInstalled.addListener((d) => {
  if (d?.reason === "install" || d?.reason === "update") {
    reinjectContentScripts({ tabs: chrome.tabs, scripting: chrome.scripting, runtime: chrome.runtime });
  }
});

const UPDATE_PAGE = "src/update.html";
// an old helper can't update itself: say so in the popup once
async function takeHelperNote() {
  const { helperOutdatedNote } = await chrome.storage.local.get("helperOutdatedNote");
  if (!helperOutdatedNote) return false;
  await chrome.storage.local.remove("helperOutdatedNote");
  return true;
}
// both installs mark the version before restarting, the page then checks it is the one running
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d?.reason !== "update") return;
  const updatedTo = await takeUpdatedTo();
  const auto = await takeAutoUpdatedTo();
  if (updatedTo && auto === updatedTo) {
    chrome.notifications?.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: "PassBridge", message: `PassBridge updated to ${auto}` });
  } else if (updatedTo) chrome.tabs.create({ url: chrome.runtime.getURL(`${UPDATE_PAGE}?updated=${encodeURIComponent(updatedTo)}`) });
});
// a folder update cut off halfway leaves its journal in the folder, the page puts the old files back
chrome.runtime.onStartup.addListener(async () => {
  if (await hasInterruptedUpdate()) chrome.tabs.create({ url: chrome.runtime.getURL(UPDATE_PAGE) });
});
ensureConnected();

function suppressChromeAutofill() {
  const svc = chrome.privacy?.services;
  if (!svc?.passwordSavingEnabled) return;
  // credit-card autofill is never touched, google pay keeps working
  getSettings().then((o) => {
    try {
      if (o.suppressSaveBubble) {
        svc.passwordSavingEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      }
      if (o.suppressAddressAutofill && svc.autofillAddressEnabled) {
        svc.autofillAddressEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      }
    } catch (_) {}
  });
}
function applySyncedPrivacy(changes) {
  const svc = chrome.privacy?.services;
  /** @type {[string, chrome.types.ChromeSetting<boolean> | undefined][]} */
  const pairs = [
    ["suppressSaveBubble", svc?.passwordSavingEnabled],
    ["suppressAddressAutofill", svc?.autofillAddressEnabled],
  ];
  for (const [key, pref] of pairs) {
    if (!changes[key] || !pref) continue;
    try {
      if (changes[key].newValue) pref.set({ value: false }, () => void chrome.runtime.lastError);
      else pref.clear({}, () => void chrome.runtime.lastError);
    } catch (_) {}
  }
}
chrome.runtime.onInstalled.addListener(suppressChromeAutofill);
chrome.runtime.onStartup.addListener(suppressChromeAutofill);
migrateSettingsToSync().catch(() => {}).then(suppressChromeAutofill);

// content messages carry sender.tab, the popup never does
function isFromOwnUi(sender) {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function httpUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

// the exact host. registrableDomain() in site-domain.js gives the site
function hostnameOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// loopback and RFC 6761 reserved TLDs are the only non-HTTPS origins treated as fillable
function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host?.endsWith(".localhost") ||
    host?.endsWith(".test")
  );
}

// one gate for every fill and save: https always, dev hosts always, plain http only on the opt-in, other schemes never
async function isFillUrlAllowed(url) {
  if (/^https:\/\//i.test(url) || isLocalDevHost(hostnameOf(url))) return true;
  return /^http:\/\//i.test(url) && (await getSettings()).canFillOnHttp === true;
}

// only these from a content script, none returns a password to the page
const CONTENT_ALLOWED = new Set([
  "reportFrame",
  "inlineLogins",
  "inlineFill",
  "inlineOneTimeCodes",
  "inlineFillOneTimeCode",
  "requestChallenge",
  "verifyPin",
  "resolveSave",
  "getPlatform",
  "getSaveDraft",
  "confirmSave",
  "neverSave",
  "dismissSave",
  "confirmTotp",
  "copyTotpKey",
  "dismissTotp",
]);

const saveOffers = new Map();
const totpOffers = new Map();
const cycleByTab = new Map();

// the bar must answer; a closed port used to look like "no bar" and saved immediately
async function presentSaveOffer({ tabId, frameUrl, target, password, host, update }) {
  saveOffers.set(tabId, {
    tabId,
    frameUrl,
    target,
    password,
    host,
    update,
    at: Date.now(),
  });
  let offered = false;
  try {
    const resp = await chrome.tabs.sendMessage(
      tabId,
      { type: "showSaveBar", username: target, update },
      { frameId: 0 },
    );
    offered = !!resp?.ok;
  } catch {}
  if (!offered) {
    // the page is already gone, so Apple's sheet is the only place left to confirm
    saveOffers.delete(tabId);
    await client.saveLogin(tabId, frameUrl, target, password);
    return { ok: true, saved: true };
  }
  setTimeout(() => {
    const offer = saveOffers.get(tabId);
    if (!offer) return;
    chrome.tabs.sendMessage(
      tabId,
      { type: "showSaveBar", username: offer.target, update: offer.update },
      { frameId: 0 },
    ).catch(() => {});
  }, 1500);
  return { ok: true, saved: false, offered: true };
}

// frames on another host or without a login form stay silent, so no frame answering means no form
async function sendFill(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

// a username fills that login. without one the shortcut starts at the most recent login and steps through the rest
async function fillLoginOnTab(tab, username, opts) {
  await ensureConnected();
  if (!client.ready || !tab?.url || tab.id == null) return { filled: false, reason: "needs_user" };
  const host = hostnameOf(tab.url);
  if (!(await isFillUrlAllowed(tab.url))) return { filled: false, reason: "not_allowed" };
  if (username == null) {
    let logins = [];
    try {
      logins = uniqueByUsername(await siteLogins(tab.id, tab.url));
    } catch {
      return { filled: false, reason: "needs_user" };
    }
    if (!logins.length) return { filled: false, reason: "no_login" };
    // stable order: re-sorting by MRU after each fill made the shortcut repeat one login
    const last = cycleByTab.get(tab.id);
    const at = last == null ? -1 : logins.findIndex((l) => (l.username || "") === last);
    username = at < 0 ? orderByMru(host, logins)[0].username : logins[(at + 1) % logins.length].username;
  }
  let cred = pwCacheGet(host, username);
  if (!cred) {
    cred = (await readPasswordForFrame(tab.id, tab.url, username)).cred;
    if (cred) pwCacheSet(host, cred);
  }
  if (!cred) return { filled: false, reason: "needs_user" };
  cycleByTab.set(tab.id, cred.username || "");
  const resp = await sendFill(tab.id, {
    type: "fill",
    username: cred.username,
    password: cred.password,
    expectedHost: host,
  });
  if (resp?.filled) {
    recordMru(host, cred.username);
    lastFillByTab.set(tab.id, { host, username: cred.username });
    return { filled: true, username: cred.username };
  }
  // agent only: the form may sit in an allowlisted child frame (account.apple.com -> idmsa.apple.com).
  // the password was read for the top site above, each frame is filled only under its own allowlisted host
  if (opts?.frameAllowlist) {
    let frames = [];
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [];
    } catch {}
    for (const f of pickAllowedFrames(frames, opts.frameAllowlist, hostnameOf)) {
      /** @type {any} */
      let r = null;
      try {
        r = await chrome.tabs.sendMessage(
          tab.id,
          { type: "fill", username: cred.username, password: cred.password, expectedHost: f.host },
          { frameId: f.frameId },
        );
      } catch {}
      if (r?.filled) {
        recordMru(host, cred.username);
        lastFillByTab.set(tab.id, { host, username: cred.username });
        return { filled: true, username: cred.username };
      }
    }
  }
  return { filled: false, reason: "fill_failed" };
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  const doc = {
    url: "src/offscreen.html",
    justification: "Copy a password and decode a QR screenshot into a verification-code link",
  };
  try {
    await chrome.offscreen.createDocument({ ...doc, reasons: ["CLIPBOARD", "DOM_PARSER"] });
  } catch {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({ ...doc, reasons: ["CLIPBOARD"] });
  }
}

// throws when the offscreen page could not write, so nothing says "Copied" over an untouched clipboard
async function copyText(text) {
  const settings = await getSettings();
  const clearMs = Number(settings.clipboardClearMs) || 10000;
  await ensureOffscreen();
  const resp = await chrome.runtime
    .sendMessage({ type: "offscreenCopy", text: text || "", clearMs })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (!resp?.ok) throw new Error(resp?.error || "Couldn't write to the clipboard.");
}

async function clearClipboard() {
  if (!(await chrome.offscreen.hasDocument())) return;
  await chrome.runtime.sendMessage({ type: "offscreenClear" }).catch(() => {});
}

function secretFresh(entry) {
  return !!entry && Date.now() - entry.at < SECRET_HOLD_MS;
}

function dropHeldOffers() {
  for (const tabId of saveOffers.keys()) {
    chrome.tabs.sendMessage(tabId, { type: "hideSaveBar" }, { frameId: 0 }).catch(() => {});
  }
  for (const tabId of totpOffers.keys()) {
    chrome.tabs.sendMessage(tabId, { type: "hideTotpBar" }, { frameId: 0 }).catch(() => {});
  }
  saveOffers.clear();
  totpOffers.clear();
}

function sweepExpiredSecrets() {
  const now = Date.now();
  for (const [tabId, offer] of saveOffers) {
    if (now - offer.at < SECRET_HOLD_MS) continue;
    saveOffers.delete(tabId);
    chrome.tabs.sendMessage(tabId, { type: "hideSaveBar" }, { frameId: 0 }).catch(() => {});
  }
  for (const [tabId, offer] of totpOffers) {
    if (secretFresh(offer)) continue;
    totpOffers.delete(tabId);
    chrome.tabs.sendMessage(tabId, { type: "hideTotpBar" }, { frameId: 0 }).catch(() => {});
  }
  for (let i = pendingSaves.length - 1; i >= 0; i--) {
    if (!secretFresh(pendingSaves[i])) pendingSaves.splice(i, 1);
  }
}

async function forgetSecrets() {
  pwCacheClear();
  dropHeldOffers();
  pendingSaves.length = 0;
  await clearClipboard();
}

// the setup key never goes on the clipboard by itself: Windows clipboard history and cloud
// clipboard keep it whatever is cleared later. copyTotpKey copies it on an explicit click.
async function handOffTotp(offer) {
  const hasKey = !!otpAuthSecret(offer?.uri);
  try {
    await ensureConnected();
    client.launchPasswordsApp({ totpUri: offer.uri, totpPageUrl: offer.pageUrl });
  } catch (e) {
    return { ok: true, launched: false, hasKey, filled: false, detail: String(e?.message ?? e) };
  }
  return { ok: true, launched: true, hasKey, filled: false };
}

async function showTotpBar(tabId, payload) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "showTotpBar", ...payload }, { frameId: 0 });
    return !!resp?.ok;
  } catch {
    return false;
  }
}

async function scanQrFromMenu(info, tab) {
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) return;
  /** @type {{ x: number, y: number, w: number, h: number, dpr: number, whole?: boolean } | null} */
  let rect = null;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "qrImageRect" }, { frameId: info.frameId ?? 0 });
    rect = resp?.rect || null;
  } catch {
    rect = null;
  }
  if (!rect) {
    await showTotpBar(tab.id, { mode: "error", error: "Right-click the image again, then scan it." });
    return;
  }
  if (rect.w < 8 || rect.h < 8) {
    await showTotpBar(tab.id, { mode: "error", error: "No QR code in that area." });
    return;
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    await showTotpBar(tab.id, { mode: "error", error: "Couldn't capture the page." });
    return;
  }
  await ensureOffscreen();
  const decoded = await chrome.runtime.sendMessage({ type: "offscreenDecodeQr", dataUrl, rect });
  if (!decoded?.ok) {
    await showTotpBar(tab.id, { mode: "error", error: decoded?.error || "Couldn't read that QR code." });
    return;
  }
  const parsed = (decoded.values || []).map(parseOtpAuth).find(Boolean);
  if (!parsed) {
    const sawQr = (decoded.values || []).length > 0;
    await showTotpBar(tab.id, {
      mode: "error",
      error: sawQr ? "This QR is not a verification-code setup link." : "No QR code in that area.",
    });
    return;
  }
  await presentTotpOffer(tab, parsed);
}

async function presentTotpOffer(tab, parsed) {
  await ensureConnected();
  if (!client.ready) {
    await showTotpBar(tab.id, { mode: "error", error: "Unlock PassBridge, then scan the code again." });
    return;
  }
  if (!client.canSetUpTotp) {
    await showTotpBar(tab.id, { mode: "error", error: "This Passwords helper can't set up verification codes." });
    return;
  }
  let logins = [];
  try {
    logins = uniqueByUsername(await siteLogins(tab.id, tab.url));
  } catch {
    logins = [];
  }
  const usernames = logins.map((login) => login.username || "(no username)").slice(0, 8);
  totpOffers.set(tab.id, {
    at: Date.now(),
    uri: parsed.uri,
    pageUrl: tab.url,
    issuer: parsed.issuer,
    account: parsed.account,
    usernames,
  });
  const shown = await showTotpBar(tab.id, {
    mode: usernames.length ? "matches" : "empty",
    issuer: parsed.issuer,
    account: parsed.account,
    usernames,
  });
  if (!shown) totpOffers.delete(tab.id);
}

// one lookup per active-tab change feeds both the badge and the right-click menu.
// background tabs cost nothing: they are looked up when they become active.
async function focusedTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// rebuilds never overlap: removeAll racing a create gave duplicate-id errors
function refreshActiveTab() {
  if (refreshRunning) {
    refreshAgain = true;
    return;
  }
  refreshRunning = true;
  (async () => {
    do {
      refreshAgain = false;
      try {
        await refreshTab(await focusedTab());
      } catch {}
    } while (refreshAgain);
    refreshRunning = false;
  })();
}

async function refreshTab(tab) {
  const settings = await getSettings();
  const url = tab?.url && /^https?:/i.test(tab.url) ? tab.url : "";
  let logins = [];
  if (url && tab.id != null && client.ready && (settings.enableBadge || settings.enableContextMenu)) {
    try {
      logins = uniqueByUsername(orderByMru(hostnameOf(url), await siteLogins(tab.id, url)));
    } catch {}
  }
  if (tab?.id != null) setCountBadge(tab.id, settings.enableBadge ? logins.length : 0);
  await rebuildContextMenu(settings, tab, url, logins.slice(0, 8));
}

const BADGE_COLOR = "#0a84ff";

// no count drops the tab's own text, so the global update badge shows through
function setCountBadge(tabId, n) {
  chrome.action.setBadgeText(n ? { text: n > 9 ? "9+" : String(n), tabId } : { tabId }).catch(() => {});
  if (n) chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId }).catch(() => {});
}

async function syncUpdateBadge() {
  let update;
  try {
    update = await availableUpdate();
  } catch {
    // the worker is shutting down for a reload, the next start syncs the badge
    return;
  }
  const { name } = chrome.runtime.getManifest();
  chrome.action.setBadgeText({ text: update ? "NEW" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  chrome.action.setTitle({ title: update ? `${name} ${update.version} is available!` : name }).catch(() => {});
}

async function rebuildContextMenu(settings, tab, url, logins) {
  if (!chrome.contextMenus) return;
  menuFor = { tabId: null, host: "", logins: [] };
  await new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve(void chrome.runtime.lastError)));
  if (!settings.enableContextMenu) return;
  const add = (props) => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);
  add({ id: "pb-root", title: "PassBridge", contexts: ["editable", "page", "image"] });
  add({ id: "pb-fill", parentId: "pb-root", title: "Autofill login", contexts: ["editable", "page"] });
  add({ id: "pb-user", parentId: "pb-root", title: "Copy username", contexts: ["editable", "page"] });
  add({ id: "pb-pass", parentId: "pb-root", title: "Copy password", contexts: ["editable", "page"] });
  add({ id: "pb-otp", parentId: "pb-root", title: "Copy verification code", contexts: ["editable", "page"] });
  add({ id: "pb-gen", parentId: "pb-root", title: "Generate password", contexts: ["editable", "page"] });
  add({ id: "pb-gen-copy", parentId: "pb-root", title: "Generate password and copy", contexts: ["editable", "page"] });
  add({ id: "pb-qr-image", parentId: "pb-root", title: "Scan this image for a verification code", contexts: ["image"] });
  add({ id: "pb-report", parentId: "pb-root", title: "Report this page…", contexts: ["page"] });
  logins.forEach((login, i) => {
    add({ id: `pb-login-${i}`, parentId: "pb-fill", title: login.username || "(no username)", contexts: ["editable", "page"] });
  });
  menuFor = { tabId: tab?.id ?? null, host: (url && hostnameOf(url)) || "", logins };
}

// "Report this page": every frame of the tab sends its scrubbed snapshot, gathered for a short window
/** @type {Map<string, { tabId: number, frames: any[] }>} */
const pendingReports = new Map();
const REPORT_GATHER_MS = 1500;

async function reportPage(tab) {
  if (tab?.id == null) throw new Error("no tab");
  const id = crypto.randomUUID();
  /** @type {{ tabId: number, frames: any[] }} */
  const entry = { tabId: tab.id, frames: [] };
  pendingReports.set(id, entry);
  await chrome.tabs.sendMessage(tab.id, { type: "collectReport", id }).catch(() => {});
  await new Promise((r) => setTimeout(r, REPORT_GATHER_MS));
  pendingReports.delete(id);
  entry.frames.sort((a, b) => (b.top ? 1 : 0) - (a.top ? 1 : 0) || a.frameId - b.frameId);
  const report = {
    url: scrubUrl(tab.url || ""),
    version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent,
    createdAt: new Date().toISOString(),
    frames: entry.frames,
  };
  await chrome.storage.session.set({ [`report:${id}`]: report });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/report.html?id=${id}`), index: tab.index + 1 });
}

function clearBadges() {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs || []) {
      if (t.id != null) setCountBadge(t.id, 0);
    }
  });
}

// an inline PIN box left open finishes when the popup unlocked instead, in whichever frame it is
function notifyUnlocked() {
  focusedTab()
    .then((tab) => {
      if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: "unlocked" }).catch(() => {});
    })
    .catch(() => {});
}

chrome.commands?.onCommand.addListener(async (command) => {
  if (command === "lock-vault") {
    await forgetSecrets();
    client.disconnect();
    clearBadges();
    refreshActiveTab();
    return;
  }
  const tab = await activeTab();
  if (tab?.id == null) return;
  if (command === "fill-login") chrome.tabs.sendMessage(tab.id, { type: "shortcut" }).catch(() => {});
  else if (command === "autofill-login") await fillLoginOnTab(tab);
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === "pb-report") {
      await reportPage(tab);
      return;
    }
    if (info.menuItemId === "pb-gen") {
      chrome.tabs.sendMessage(tab.id, { type: "generatePassword" }, { frameId: info.frameId ?? 0 }).catch(() => {});
      return;
    }
    if (info.menuItemId === "pb-gen-copy") {
      await copyText(generateApplePassword());
      return;
    }
    if (info.menuItemId === "pb-qr-image") {
      await scanQrFromMenu(info, tab);
      return;
    }
    if (String(info.menuItemId).startsWith("pb-login-")) {
      // the list belongs to the tab and site it was built for, anywhere else it names the wrong account
      const fresh = menuFor.tabId === tab.id && menuFor.host === hostnameOf(tab.url || "");
      const login = fresh ? menuFor.logins[Number(String(info.menuItemId).slice("pb-login-".length))] : null;
      if (login) await fillLoginOnTab(tab, login.username);
      else refreshActiveTab();
      return;
    }
    if (info.menuItemId === "pb-fill") {
      await fillLoginOnTab(tab);
      return;
    }
    if (!client.ready || !tab.url) return;
    const host = hostnameOf(tab.url);
    let logins = [];
    try {
      logins = uniqueByUsername(orderByMru(host, await siteLogins(tab.id, tab.url)));
    } catch { return; }
    const login = logins[0];
    if (!login) return;
    if (info.menuItemId === "pb-user") await copyText(login.username || "");
    else if (info.menuItemId === "pb-pass") {
      const { cred } = await readPasswordForFrame(tab.id, tab.url, login.username);
      if (cred?.password) await copyText(cred.password);
    } else if (info.menuItemId === "pb-otp") {
      const { rows } = await listOneTimeCodes(tab.id, 0, [tab.url]);
      if (rows[0]) await copyText(await resolveOneTimeCode(tab.id, rows[0].id));
    }
  } catch (e) {
    console.info("[PassBridge] context menu", { item: info.menuItemId, error: String(e?.message ?? e) });
  }
});

chrome.tabs?.onActivated.addListener(() => refreshActiveTab());
chrome.windows?.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) refreshActiveTab();
});
chrome.tabs?.onUpdated.addListener((tabId, info) => {
  // a navigated tab drops its old count for free; it is looked up again once it is active
  if (info.url) setCountBadge(tabId, 0);
  if (info.status !== "complete") return;
  focusedTab()
    .then((tab) => {
      if (tab?.id === tabId) refreshActiveTab();
    })
    .catch(() => {});
  const offer = saveOffers.get(tabId);
  if (offer && Date.now() - offer.at < 20000) {
    chrome.tabs.sendMessage(
      tabId,
      { type: "showSaveBar", username: offer.target, update: offer.update },
      { frameId: 0 },
    ).catch(() => {});
  }
});
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== "local" && area !== SETTINGS_AREA) return;
  if (changes.enableBadge?.newValue === false) clearBadges();
  if (changes.enableContextMenu || changes.enableBadge) refreshActiveTab();
  // switched in another Chrome of this profile: apply it to this one too
  if (area === SETTINGS_AREA) applySyncedPrivacy(changes);
  if (changes.latestRelease || changes.dismissedRelease || changes.canCheckForUpdates) syncUpdateBadge();
  if (changes.canCheckForUpdates?.newValue) checkForUpdate(Date.now(), { force: true });
});
(async () => { await checkForUpdate(); await autoInstallUpdate(); })().catch(() => {});
syncUpdateBadge();
// main_frame in the filter, not the callback: every image and XHR would otherwise wake the worker
try {
  chrome.webRequest?.onCompleted.addListener((details) => {
    if (!saveOffers.has(details.tabId)) return;
    const method = String(details.method || "").toUpperCase();
    if (!["POST", "PUT", "PATCH"].includes(method)) return;
    if (details.statusCode >= 400) {
      saveOffers.delete(details.tabId);
      chrome.tabs.sendMessage(details.tabId, { type: "hideSaveBar" }, { frameId: 0 }).catch(() => {});
    }
  }, { urls: ["<all_urls>"], types: ["main_frame"] });
} catch {}

chrome.tabs?.onRemoved.addListener((tabId) => {
  totpOffers.delete(tabId);
  saveOffers.delete(tabId);
  cycleByTab.delete(tabId);
  lastFillByTab.delete(tabId);
  for (let i = pendingSaves.length - 1; i >= 0; i--) {
    if (pendingSaves[i].tabId === tabId) pendingSaves.splice(i, 1);
  }
  pwCacheClear();
});
chrome.tabs?.onUpdated.addListener((tabId, info) => {
  if (!info.url || !totpOffers.has(tabId)) return;
  totpOffers.delete(tabId);
  chrome.tabs.sendMessage(tabId, { type: "hideTotpBar" }, { frameId: 0 }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const fromUi = isFromOwnUi(sender);
      const fromContent = sender.id === chrome.runtime.id && sender.tab !== undefined;
      if (!fromUi && !(fromContent && CONTENT_ALLOWED.has(msg?.type))) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }

      switch (msg?.type) {
        case "inlineLogins": {
          // keyed to sender.url not the top tab
          const frameUrl = sender.url;
          if (!frameUrl) return sendResponse({ ok: false, error: "no frame" });
          await ensureConnected();
          if (client.state === State.NoHelper) return sendResponse({ ok: true, locked: false, logins: [] });
          if (!client.ready) return sendResponse({ ok: true, locked: true, logins: [] });
          try {
            const logins = await siteLogins(sender.tab?.id, frameUrl);
            sendResponse({
              ok: true,
              locked: false,
              logins: publicLogins(uniqueByUsername(orderByMru(hostnameOf(frameUrl), logins))),
            });
          } catch {
            sendResponse({ ok: true, locked: false, logins: [] });
          }
          break;
        }

        case "inlineOneTimeCodes": {
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) return sendResponse({ ok: false, error: "no frame" });
          await ensureConnected();
          // capabilities arrive with the hello, before the PIN, so locked still knows if codes are supported
          if (client.state === State.NoHelper) return sendResponse({ ok: true, locked: false, supported: false, rows: [] });
          if (!client.ready) return sendResponse({ ok: true, locked: true, supported: client.canFillOneTimeCodes, rows: [] });
          if (!client.canFillOneTimeCodes) return sendResponse({ ok: true, locked: false, supported: false, rows: [] });
          try {
            const { rows, requiresAuth } = await listOneTimeCodes(sender.tab.id, sender.frameId ?? 0, frameUrlsFor(sender));
            sendResponse({ ok: true, locked: false, supported: true, rows, requiresAuth });
          } catch (e) {
            sendResponse({ ok: true, locked: false, supported: true, rows: [], error: String(e?.message ?? e) });
          }
          break;
        }

        case "inlineFillOneTimeCode": {
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) return sendResponse({ ok: false, error: "no frame" });
          const host = hostnameOf(frameUrl);
          if (!(await isFillUrlAllowed(frameUrl))) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          const code = await resolveOneTimeCode(sender.tab.id, Number(msg.id));
          // the frame stays silent when its code field is gone
          const resp = await chrome.tabs
            .sendMessage(sender.tab.id, { type: "fillOtp", code, expectedHost: host }, { frameId })
            .catch(() => null);
          if (!resp?.filled) return sendResponse({ ok: false, filled: false, error: "Couldn't find the code field." });
          if ((await getSettings()).copyTotpAfterFill) await copyText(code).catch(() => {});
          sendResponse({ ok: true, filled: true });
          break;
        }

        case "inlineFill": {
          // frameId scopes the fill to the requesting frame, never broadcast (confused deputy)
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const host = hostnameOf(frameUrl);
          if (!(await isFillUrlAllowed(frameUrl))) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          // pass only the username through, sites is caller-supplied
          const safeLogin = { username: msg.loginName?.username };
          let cred = pwCacheGet(host, safeLogin.username);
          if (!cred) {
            try {
              const read = await readPasswordForFrame(sender.tab.id, frameUrl, safeLogin.username);
              cred = read.cred;
              if (!cred) console.info("[PassBridge] inlineFill", { status: "no credential", host, tried: read.tried });
            } catch (e) {
              const error = String(e?.message ?? e);
              console.info("[PassBridge] inlineFill", { status: "helper error", host, error });
              return sendResponse({ ok: false, filled: false, error });
            }
            if (cred) pwCacheSet(host, cred);
          }
          if (!cred) {
            return sendResponse({
              ok: false,
              filled: false,
              error: "Couldn't read the password for this site.",
            });
          }
          let resp;
          try {
            resp = await chrome.tabs.sendMessage(
              sender.tab.id,
              {
                type: "fill",
                username: cred.username,
                password: cred.password,
                expectedHost: host,
              },
              { frameId },
            );
          } catch (e) {
            console.info("[PassBridge] inlineFill", { status: "fill message failed", host, error: String(e?.message ?? e) });
            // the frame stays silent when it has no login field left to fill
            return sendResponse({ ok: false, filled: false, error: "Couldn't find a login form on this page." });
          }
          const filled = !!resp?.filled;
          if (filled) {
            recordMru(host, cred.username);
            lastFillByTab.set(sender.tab.id, { host, username: cred.username });
            sendResponse({ ok: true, filled: true });
            break;
          }
          const status = resp?.error || "no fields";
          console.info("[PassBridge] inlineFill", { status, host });
          sendResponse({
            ok: false,
            filled: false,
            error: status === "no fields" ? "Couldn't fill this page." : status,
          });
          break;
        }

        case "resolveSave": {
          // saving here so a submit that navigates cant kill it
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const host = hostnameOf(frameUrl);
          if (!(await isFillUrlAllowed(frameUrl))) {
            return sendResponse({ ok: false, error: "refusing to save from a non-HTTPS frame" });
          }
          if (!msg.password) return sendResponse({ ok: false, error: "no password" });
          const detected = (msg.username || "").trim();
          const generated = !!msg.generated;
          const newPwCtx = !!msg.newPwCtx;
          await ensureConnected();

          // locked: stash a new-password save for unlock, a plain re-login isnt worth deferring
          if (!client.ready) {
            if (generated || newPwCtx) {
              queuePendingSave({
                host,
                frameUrl,
                tabId: sender.tab.id,
                detected,
                password: msg.password,
                generated,
                newPwCtx,
              });
            }
            return sendResponse({ ok: true, saved: false, locked: true });
          }

          let existing = [];
          try {
            existing = (await siteLogins(sender.tab.id, frameUrl))
              .map((l) => l.username)
              .filter(Boolean);
          } catch {}
          const target = pickSaveTarget({ host, existing, detected, generated, newPwCtx });
          console.debug("[PassBridge] resolveSave", {
            host,
            detected: detected || "(none)",
            generated,
            newPwCtx,
            existingCount: existing.length,
            target: target === null ? "(skip)" : target || "(ask)",
          });
          if (target === null) return sendResponse({ ok: true, saved: false, skipped: true });
          const settings = await getSettings();
          if (hostBlocked(host, settings.excludedDomains)) {
            return sendResponse({ ok: true, saved: false, skipped: true });
          }
          const isUpdate = existing.some((u) => u.toLowerCase() === String(target).toLowerCase());
          if ((isUpdate && settings.askToUpdate === false) || (!isUpdate && settings.askToSave === false)) {
            return sendResponse({ ok: true, saved: false, skipped: true });
          }
          sendResponse(await presentSaveOffer({
            tabId: sender.tab.id,
            frameUrl,
            target,
            password: msg.password,
            host,
            update: isUpdate,
          }));
          break;
        }

        case "getSaveDraft": {
          // only our own bar iframe gets the captured password back, to show it for editing
          const tabId = sender.tab?.id;
          const offer = tabId != null ? saveOffers.get(tabId) : null;
          if (!secretFresh(offer) || !(sender.url || "").startsWith(chrome.runtime.getURL("overlay/save-bar.html"))) {
            return sendResponse({ ok: false, error: "nothing to edit" });
          }
          sendResponse({ ok: true, username: offer.target || "", password: offer.password });
          break;
        }

        case "confirmSave": {
          const tabId = sender.tab?.id;
          const offer = tabId != null ? saveOffers.get(tabId) : null;
          if (tabId == null || !secretFresh(offer)) {
            if (tabId != null) saveOffers.delete(tabId);
            return sendResponse({ ok: false, error: "nothing to save" });
          }
          saveOffers.delete(tabId);
          await ensureConnected();
          // the bar lets the user fix a missing username or a wrong password before saving
          const username = typeof msg.username === "string" ? msg.username.trim() : offer.target;
          const password = typeof msg.password === "string" && msg.password ? msg.password : offer.password;
          await client.saveLogin(offer.tabId, offer.frameUrl, username, password);
          sendResponse({ ok: true, saved: true });
          break;
        }

        case "dismissSave": {
          if (sender.tab?.id != null) saveOffers.delete(sender.tab.id);
          sendResponse({ ok: true });
          break;
        }

        case "confirmTotp": {
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          const offer = sender.tab?.id != null ? totpOffers.get(sender.tab.id) : null;
          if (!secretFresh(offer)) {
            if (sender.tab?.id != null) totpOffers.delete(sender.tab.id);
            return sendResponse({ ok: false, error: "nothing to add" });
          }
          // held until it expires so the bar can offer the setup key on an explicit click
          offer.handedOff = true;
          sendResponse(await handOffTotp(offer));
          break;
        }

        case "copyTotpKey": {
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          const offer = sender.tab?.id != null ? totpOffers.get(sender.tab.id) : null;
          if (sender.tab?.id != null) totpOffers.delete(sender.tab.id);
          const secret = offer?.handedOff && secretFresh(offer) ? otpAuthSecret(offer.uri) : "";
          if (!secret) return sendResponse({ ok: false, error: "The setup key is no longer held. Scan the code again." });
          await copyText(secret);
          sendResponse({ ok: true, copied: true });
          break;
        }

        case "dismissTotp": {
          if (sender.tab?.id != null) totpOffers.delete(sender.tab.id);
          sendResponse({ ok: true });
          break;
        }

        case "neverSave": {
          // the whole site: never saving on www.example.com also covers login.example.com
          const host = hostnameOf(sender.url || "");
          const site = host ? registrableDomain(host) : "";
          if (sender.tab?.id != null) saveOffers.delete(sender.tab.id);
          if (site) {
            const settings = await getSettings();
            const excludedDomains = Array.from(new Set([...(settings.excludedDomains || []), site]));
            await settingsStore().set({ excludedDomains });
          }
          sendResponse({ ok: true });
          break;
        }

        case "lookupLogins": {
          const raw = String(msg.url || "").trim();
          if (!raw) return sendResponse({ ok: false, error: "no site" });
          const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
          const tab = await activeTab();
          if (!tab?.id) return sendResponse({ ok: false, error: "no tab" });
          if (!client.ready) return sendResponse({ ok: false, error: "PassBridge is locked." });
          const logins = uniqueByUsername(await siteLogins(tab.id, url));
          sendResponse({ ok: true, host: hostnameOf(url), logins: publicLogins(logins) });
          break;
        }

        case "copyField": {
          const tab = await activeTab();
          if (!tab?.url || tab.id == null) return sendResponse({ ok: false, error: "no tab" });
          const url = httpUrl(msg.url) || tab.url;
          let text = "";
          if (msg.field === "username") text = msg.username || "";
          else if (msg.field === "password") {
            const { cred } = await readPasswordForFrame(tab.id, url, msg.username);
            text = cred?.password || "";
            if (!text) return sendResponse({ ok: false, error: "Couldn't read the password for that login." });
          } else if (msg.field === "otp") {
            text = await resolveOneTimeCode(tab.id, Number(msg.id));
          }
          if (!text) return sendResponse({ ok: false, error: "Nothing to copy." });
          await copyText(text);
          sendResponse({ ok: true, copied: true });
          break;
        }

        case "getSettings": {
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        }

        case "getPlatform":
          await platformReady;
          sendResponse({ ok: true, os: platformOs, label: labelForOs(platformOs) });
          break;

        case "checkUpdateNow": {
          const reached = await checkForUpdate(Date.now(), { force: true });
          const { latestRelease } = await chrome.storage.local.get("latestRelease");
          sendResponse({ ok: true, reached: !!reached, latest: latestRelease ?? null, available: await availableUpdate(), current: chrome.runtime.getManifest().version });
          break;
        }

        case "getState":
          await platformReady;
          await ensureConnected();
          sendResponse({
            ok: true,
            state: client.state,
            os: platformOs,
            label: labelForOs(platformOs),
            hasChallenge: client.hasChallenge,
            settings: await getSettings(),
            update: await availableUpdate(),
            helperNote: await takeHelperNote(),
            canInstallUpdate: (await availableUpdate()) ? await updaterAvailable() : false,
            caps: {
              oneTimeCodes: client.canFillOneTimeCodes,
              newPasswordSheet: client.canOpenPasswordsAppToNewPasswordSheet,
              setUpTotp: client.canSetUpTotp,
            },
          });
          break;

        case "getOneTimeCodes": {
          const tab = await activeTab();
          const url = httpUrl(msg.url) || tab?.url;
          if (!tab?.id || !url) return sendResponse({ ok: false, error: "no active tab" });
          if (!client.ready) return sendResponse({ ok: true, rows: [] });
          if (!client.canFillOneTimeCodes) return sendResponse({ ok: true, supported: false, rows: [] });
          const { rows, requiresAuth } = await listOneTimeCodes(tab.id, 0, frameUrlsFor({ url }));
          sendResponse({ ok: true, supported: true, rows, requiresAuth });
          break;
        }

        case "fillOneTimeCode": {
          // every frame gets it, only the one with a code field acts. value returned so the popup can show it if none did
          const tab = await activeTab();
          if (!tab?.url || tab.id == null) return sendResponse({ ok: false, error: "no active tab" });
          const host = hostnameOf(tab.url);
          if (!(await isFillUrlAllowed(tab.url))) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          const tabId = tab.id;
          const code = await resolveOneTimeCode(tabId, Number(msg.id));
          let filled = false;
          try {
            const frames = await new Promise((resolve) =>
              chrome.tabs.sendMessage(tabId, { type: "fillOtp", code, expectedHost: host }, (r) => {
                void chrome.runtime.lastError;
                resolve(r);
              }),
            );
            filled = !!frames?.filled;
          } catch (_) {}
          if (filled && (await getSettings()).copyTotpAfterFill) await copyText(code).catch(() => {});
          sendResponse({ ok: true, filled, code });
          break;
        }

        case "openPasswordsApp": {
          const tab = await activeTab();
          const url = httpUrl(msg.url) || (tab?.url && /^https?:/i.test(tab.url) ? tab.url : undefined);
          await ensureConnected();
          if (msg.mode === "new") {
            client.launchPasswordsApp({ newPasswordUrl: url });
          } else {
            client.launchPasswordsApp({ searchUrl: url });
          }
          sendResponse({ ok: true });
          break;
        }

        case "connect":
          await ensureConnected();
          sendResponse({ ok: true, state: client.state });
          break;

        case "requestChallenge": {
          // top frame or popup only, so a hostile sub-frame cant spam native prompts
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          await platformReady;
          await ensureConnected();
          const issued = await withTimeout(
            client.requestChallenge({ ifNeeded: !!msg.ifNeeded }),
            8000,
            "challenge timed out",
          );
          // the Windows toast steals focus and closes this popup; reopen it once the code is up
          if (platformOs === "win" && fromUi && issued !== false) {
            setTimeout(() => {
              try {
                chrome.action.openPopup(() => void chrome.runtime.lastError);
              } catch (_) {}
            }, 700);
          }
          sendResponse({ ok: true, state: client.state, hasChallenge: client.hasChallenge });
          break;
        }

        case "verifyPin": {
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          await platformReady;
          await ensureConnected();
          try {
            await withTimeout(client.verifyPin(msg.pin), 8000, "verification timed out");
          } catch (e) {
            // a spent challenge cant be retried, put a fresh code up or the user retypes a dead code forever
            let newCode = e?.code === "challenge_reissued";
            if (!newCode && !client.hasChallenge && client.state === State.NeedsPin) {
              try {
                await withTimeout(client.requestChallenge(), 8000, "challenge timed out");
                newCode = true;
              } catch (_) {}
            }
            return sendResponse({
              ok: false,
              error: String(e?.message ?? e),
              newCode,
              state: client.state,
            });
          }
          sendResponse({ ok: true, state: client.state });
          if (client.ready) flushPendingSaves();
          break;
        }

        case "getLogins": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const logins = await siteLogins(tab.id, tab.url);
          const ordered = publicLogins(uniqueByUsername(orderByMru(hostnameOf(tab.url), logins)));
          // the page may already name the account (Gmail's password page), that login goes first
          let pageName = "";
          try {
            const r = await chrome.tabs.sendMessage(tab.id ?? 0, { type: "pageUsername" }, { frameId: 0 });
            if (typeof r?.username === "string") pageName = r.username.slice(0, 320);
          } catch {}
          sendResponse({ ok: true, logins: orderByPageUsername(ordered, pageName) });
          break;
        }

        case "fillOnPage": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const pageHost = hostnameOf(tab.url);
          if (!(await isFillUrlAllowed(tab.url))) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          const credUrl = httpUrl(msg.url) || tab.url;
          const credHost = hostnameOf(credUrl);
          const sameSite = credHost === pageHost;
          let cred = sameSite ? pwCacheGet(pageHost, msg.loginName?.username) : null;
          if (!cred) {
            cred = (await readPasswordForFrame(tab.id, credUrl, msg.loginName?.username)).cred;
            if (cred && sameSite) pwCacheSet(pageHost, cred);
          }
          if (!cred) {
            return sendResponse({ ok: false, filled: false, error: "No saved password for that login." });
          }
          // content script re-checks expectedHost against the page being filled
          const resp = await sendFill(tab.id, {
            type: "fill",
            username: cred.username,
            password: cred.password,
            expectedHost: pageHost,
          });
          const filled = !!resp?.filled;
          if (filled && sameSite) {
            recordMru(pageHost, cred.username);
            lastFillByTab.set(tab.id, { host: pageHost, username: cred.username });
          }
          sendResponse(filled
            ? { ok: true, filled: true }
            : { ok: false, filled: false, error: resp?.error || "Couldn't find a login form on this page." });
          break;
        }

        case "refreshAndRefill": {
          // re-fill so a password changed in the Passwords app lands without re-clicking Fill
          pwCacheClear();
          const tab = await activeTab();
          const entry = tab?.id != null ? lastFillByTab.get(tab.id) : null;
          const host = tab?.url ? hostnameOf(tab.url) : null;
          if (!entry || !host || entry.host !== host) {
            return sendResponse({ ok: true, refilled: false, reason: "none" });
          }
          try {
            const { cred } = await readPasswordForFrame(tab.id, tab.url, entry.username);
            if (!cred) return sendResponse({ ok: false, refilled: false, error: "No saved password for that login." });
            pwCacheSet(host, cred);
            const resp = await sendFill(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              expectedHost: host,
            });
            if (!resp?.filled) {
              return sendResponse({ ok: false, refilled: false, error: resp?.error || "Couldn't find a login form on this page." });
            }
            sendResponse({ ok: true, refilled: true, username: cred.username });
          } catch (e) {
            sendResponse({ ok: false, refilled: false, error: String(e?.message ?? e) });
          }
          break;
        }

        case "clearCache":
          pwCacheClear();
          sendResponse({ ok: true });
          break;

        case "installUpdate":
          sendResponse(await installUpdate());
          break;

        case "dismissUpdate":
          await dismissUpdate();
          sendResponse({ ok: true });
          break;

        case "reportFrame": {
          const entry = pendingReports.get(msg.id);
          if (entry && sender.tab?.id === entry.tabId && msg.frame && typeof msg.frame === "object") {
            entry.frames.push({ ...msg.frame, frameId: sender.frameId ?? 0 });
          }
          sendResponse({ ok: true });
          break;
        }

        case "reportPage": {
          await reportPage(await activeTab());
          sendResponse({ ok: true });
          break;
        }

        case "disconnect":
          await forgetSecrets();
          client.disconnect();
          sendResponse({ ok: true, state: client.state });
          break;

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e), state: client.state });
    }
  })();
  return true;
});

initAgent({
  client,
  getSettings,
  getTab: (id) => chrome.tabs.get(id),
  hostnameOf,
  isFillUrlAllowed,
  siteLogins,
  uniqueByUsername,
  fillLoginOnTab,
});
