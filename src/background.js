// @ts-check
// alarm keep-alive holds the MV3 worker so the PIN isnt re-prompted every idle-out

import { State, setDeviceLabel } from "./apple/protocol.js";
import { createClient } from "./session/create-client.js";
import { labelForOs, uiDeviceLabel } from "./apple/os-label.js";
import { SETTINGS_AREA, getSettings, hostBlocked, migrateSettingsToSync, settingsStore } from "./settings.js";
import { generateAlphanumericPassword, generateApplePassword } from "./password-generate.js";
import { otpAuthSecret, parseOtpAuth } from "./otpauth.js";
import { parseSetupInput, totpHandoff, withAccount } from "./totp-setup.js";
import { passwordSearchSteps } from "./session/password-search.js";
import { listOtpEntries } from "./session/otp-list.js";
import { registrableDomain, siteLookupHosts } from "./session/site-domain.js";
import { orderByUse, recordUse } from "./session/mru.js";
import { addToAllowlist, agentHostFor, agentOfferFor } from "./session/agent-allow.js";
import { frameUrlsFor } from "./session/frame-urls.js";
import { orderByPageUsername } from "./session/username-match.js";
import { scrubUrl } from "./report-scrub.js";
import { initAgent, loginSavedFor, pickAllowedFrames } from "./agent.js";
import { UPDATE_PAGE, availableUpdate, checkForUpdate, dismissUpdate, takeUpdatedTo } from "./update/check.js";
import { autoInstallUpdate, installUpdate, takeAutoUpdatedTo, updaterAvailable } from "./update/install.js";
import { hasInterruptedUpdate } from "./update/files.js";
import { reinjectContentScripts } from "./reload-recovery.js";
import { loginAction, menuItems } from "./menu.js";
import { confirmLoginAdded, countLogins, useNewLoginSheet } from "./session/add-login-check.js";
import { invalidateLocale, resolveLocale, t } from "./i18n/runtime.js";
import { PASSKEY_SETTING, createPasskeyProxy } from "./passkeys/proxy.js";
import { MOCK_KIND } from "./session/mock-kind.js";
import { isPasskeyLogin } from "./passkeys/record.js";
import { savePasskey } from "./passkeys/store.js";

// menu titles and the errors sent back to the pages follow the UI language
void resolveLocale();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === SETTINGS_AREA && changes.uiLanguage) {
    invalidateLocale();
    void resolveLocale();
  }
});

const client = createClient();

// passkeys held in the vault, answered through chrome.webAuthenticationProxy (Windows, opt in).
// Listeners are added here at the top level so they exist each time the worker wakes.
const passkeyProxy = createPasskeyProxy({
  api: () => chrome.webAuthenticationProxy,
  client,
  ensureConnected: () => ensureConnected(),
  // Windows only: on macOS Chrome already uses iCloud passkeys and attaching would hide them
  // (the passkeys test build runs on Linux CI, so it skips the check)
  enabled: async () =>
    (MOCK_KIND === "passkeys" || (await chrome.runtime.getPlatformInfo()).os === "win") &&
    (await chrome.storage.local.get({ [PASSKEY_SETTING]: false }))[PASSKEY_SETTING] === true,
  getTab: () => focusedTab(),
  notifyUnlock: () => chrome.notifications?.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: t("extensionName"), message: t("passkeyUnlockNeeded") }),
});
passkeyProxy.register();
void passkeyProxy.refresh();
chrome.permissions?.onAdded?.addListener(() => {
  passkeyProxy.register();
  void passkeyProxy.refresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PASSKEY_SETTING]) {
    passkeyProxy.invalidate();
    void passkeyProxy.refresh();
  }
});
chrome.tabs?.onActivated.addListener(() => void passkeyProxy.refresh());
chrome.tabs?.onUpdated.addListener((_tabId, info) => {
  if (info.url || info.status === "complete") void passkeyProxy.refresh();
});
chrome.windows?.onFocusChanged.addListener(() => void passkeyProxy.refresh());
/** @typedef {{ username: string, sites: string[], saved: string[], via: string }} SiteLogin */
/** @typedef {{ username: string, password: string, sites?: string[] }} Cred */

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
  passkeyProxy.invalidate();
  void passkeyProxy.refresh();
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

async function listOneTimeCodes(tabId, frameId, frameUrls, { listOnly = false } = {}) {
  const { entries, requiresAuth } = await listOtpEntries(client, { tabId, frameId, frameUrls, platform: await platformReady, listOnly });
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

// "" lets the native sheet ask, null saves nothing
async function pickSaveTarget({ host, existing, detected, generated, newPwCtx }) {
  const matched = detected && existing.find((u) => u.toLowerCase() === detected.toLowerCase());
  // update only on a new password, stay quiet on a plain re-login
  if (matched) return generated || newPwCtx ? matched : null;
  if (detected) return detected;
  // attach to the MRU account, apple's sheet lets the user re-pick
  if (newPwCtx && existing.length) {
    return (await orderByUse(host, existing.map((u) => ({ username: u }))))[0].username;
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
      const target = await pickSaveTarget({ ...s, existing });
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
        generated: s.generated,
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
    for (const login of (list || []).filter((l) => !isPasskeyLogin(l))) {
      const sites = Array.isArray(login.sites) ? login.sites : [];
      const seen = byName.get(normUsername(login.username));
      if (seen) {
        // a parent that lists it too becomes one more website to search
        for (const site of [...sites, h]) if (!seen.sites.includes(site)) seen.sites.push(site);
        for (const site of sites) if (!seen.saved.includes(site)) seen.saved.push(site);
        continue;
      }
      // saved is only what Apple reported, never the host we asked about
      const row = { username: login.username, sites: [...sites], saved: [...sites], via: h };
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
    chrome.notifications?.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: t("extensionName"), message: t("notificationUpdated", [auto]) });
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
  "generatedFilled",
]);

const saveOffers = new Map();
// the password last generated and filled in each tab: memory only, dropped after 10 minutes or when the tab closes
const GENERATED_HOLD_MS = 600_000;
/** @type {Map<number, { password: string, at: number, timer: any }>} */
const generatedByTab = new Map();
function dropGenerated(tabId) {
  const held = generatedByTab.get(tabId);
  if (!held) return;
  clearTimeout(held.timer);
  generatedByTab.delete(tabId);
  refreshActiveTab();
}
const totpOffers = new Map();
const cycleByTab = new Map();

// the bar must answer; a closed port used to look like "no bar" and saved immediately
async function presentSaveOffer({ tabId, frameUrl, target, password, host, update, generated }) {
  saveOffers.set(tabId, {
    tabId,
    frameUrl,
    target,
    password,
    host,
    update,
    generated: !!generated,
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
    username = at < 0 ? (await orderByUse(host, logins))[0].username : logins[(at + 1) % logins.length].username;
  }
  // every-site agent fill: no cache, and the record read must itself be saved for this host
  let cred = opts?.savedOnly ? null : pwCacheGet(host, username);
  if (!cred) {
    cred = (await readPasswordForFrame(tab.id, tab.url, username)).cred;
    if (cred && !opts?.savedOnly) pwCacheSet(host, cred);
  }
  if (!cred) return { filled: false, reason: "needs_user" };
  if (opts?.savedOnly && !loginSavedFor(host, cred.sites)) return { filled: false, reason: "not_allowed" };
  cycleByTab.set(tab.id, cred.username || "");
  const resp = await sendFill(tab.id, {
    type: "fill",
    username: cred.username,
    password: cred.password,
    expectedHost: host,
    ...(opts?.savedOnly ? { expectedOrigin: new URL(tab.url).origin } : {}),
  });
  if (resp?.filled) {
    recordUse(host, cred.username).catch(() => {});
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
        recordUse(host, cred.username).catch(() => {});
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
  if (!resp?.ok) throw new Error(resp?.error || t("couldntWriteClipboard"));
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
    client.launchPasswordsApp(totpHandoff(offer.uri, offer.pageUrl));
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
    await showTotpBar(tab.id, { mode: "error", error: t("qrRightClick") });
    return;
  }
  if (rect.w < 8 || rect.h < 8) {
    await showTotpBar(tab.id, { mode: "error", error: t("qrNoCode") });
    return;
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    await showTotpBar(tab.id, { mode: "error", error: t("couldntCapture") });
    return;
  }
  await ensureOffscreen();
  const decoded = await chrome.runtime.sendMessage({ type: "offscreenDecodeQr", dataUrl, rect });
  if (!decoded?.ok) {
    await showTotpBar(tab.id, { mode: "error", error: decoded?.error || t("qrUnreadableBg") });
    return;
  }
  const parsed = (decoded.values || []).map(parseOtpAuth).find(Boolean);
  if (!parsed) {
    const sawQr = (decoded.values || []).length > 0;
    await showTotpBar(tab.id, {
      mode: "error",
      error: sawQr ? t("qrNotSetup") : t("qrNoCode"),
    });
    return;
  }
  await presentTotpOffer(tab, parsed);
}

async function presentTotpOffer(tab, parsed) {
  await ensureConnected();
  if (!client.ready) {
    await showTotpBar(tab.id, { mode: "error", error: t("qrUnlockFirst") });
    return;
  }
  if (!client.canSetUpTotp) {
    await showTotpBar(tab.id, { mode: "error", error: t("totpUnsupported") });
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
      logins = uniqueByUsername(await orderByUse(hostnameOf(url), await siteLogins(tab.id, url)));
    } catch {}
  }
  if (tab?.id != null) setCountBadge(tab.id, settings.enableBadge ? logins.length : 0);
  // listing codes needs no Touch ID; Windows may only find synced codes per login, so it keeps the item there
  let hasCode = false;
  if (logins.length && settings.enableContextMenu) {
    try {
      hasCode = (await platformReady) === "win" || (await client.getOneTimeCodes(tab.id, 0, [url])).entries.length > 0;
    } catch {}
  }
  await rebuildContextMenu(settings, tab, url, logins.slice(0, 8), hasCode);
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
  chrome.action.setBadgeText({ text: update ? t("badgeNew") : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  chrome.action.setTitle({ title: update ? `${name} ${t("updateAvailable", [update.version])}` : name }).catch(() => {});
}

async function rebuildContextMenu(settings, tab, url, logins, hasCode = false) {
  if (!chrome.contextMenus) return;
  menuFor = { tabId: null, host: "", logins: [] };
  await new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve(void chrome.runtime.lastError)));
  if (!settings.enableContextMenu) return;
  await resolveLocale();
  for (const props of menuItems({ ready: client.ready, onSite: !!url, logins, hasCode, hasGenerated: tab?.id != null && generatedByTab.has(tab.id) })) chrome.contextMenus.create(props, () => void chrome.runtime.lastError);
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
    if (info.menuItemId === "pb-gen" || info.menuItemId === "pb-gen-alnum") {
      chrome.tabs.sendMessage(tab.id, { type: "generatePassword", alnum: info.menuItemId === "pb-gen-alnum" }, { frameId: info.frameId ?? 0 }).catch(() => {});
      return;
    }
    if (info.menuItemId === "pb-gen-copy") {
      await copyText(generateApplePassword());
      return;
    }
    if (info.menuItemId === "pb-gen-copy-alnum") {
      await copyText(generateAlphanumericPassword());
      return;
    }
    if (info.menuItemId === "pb-gen-last") {
      const held = generatedByTab.get(tab.id);
      if (held) await copyText(held.password);
      return;
    }
    if (info.menuItemId === "pb-qr-image") {
      await scanQrFromMenu(info, tab);
      return;
    }
    if (info.menuItemId === "pb-unlock") {
      chrome.action.openPopup(() => void chrome.runtime.lastError);
      return;
    }
    if (info.menuItemId === "pb-otp") {
      if (!client.ready || !tab.url) return;
      const { rows } = await listOneTimeCodes(tab.id, 0, [tab.url]);
      if (rows[0]) await copyText(await resolveOneTimeCode(tab.id, rows[0].id));
      return;
    }
    const pick = loginAction(info.menuItemId);
    if (!pick) return;
    // the list belongs to the tab and site it was built for, anywhere else it names the wrong account
    const fresh = menuFor.tabId === tab.id && menuFor.host === hostnameOf(tab.url || "");
    const login = fresh ? menuFor.logins[pick.index] : null;
    if (!login) {
      refreshActiveTab();
      return;
    }
    if (pick.action === "fill") await fillLoginOnTab(tab, login.username);
    else if (pick.action === "user") await copyText(login.username || "");
    else {
      const { cred } = await readPasswordForFrame(tab.id, tab.url, login.username);
      if (cred?.password) await copyText(cred.password);
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
  clearTimeout(generatedByTab.get(tabId)?.timer);
  generatedByTab.delete(tabId);
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
      // the update page runs in a tab, so it is told apart by its own extension URL and may only install
      const fromUpdatePage = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(UPDATE_PAGE));
      const fromOptionsPage = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL("src/options.html"));
      if (!fromUi && !(fromContent && CONTENT_ALLOWED.has(msg?.type)) && !(fromUpdatePage && msg?.type === "installUpdate") && !(fromOptionsPage && msg?.type?.startsWith("passkey"))) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }

      switch (msg?.type) {
        // options page only: save one imported passkey, and drop the proxy before the permission is removed
        case "passkeySave": {
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: false, error: t("errUnlockFirst") });
          const tab = await focusedTab();
          const result = await savePasskey(client, tab?.id ?? 0, msg.record);
          passkeyProxy.invalidate();
          void passkeyProxy.refresh();
          return sendResponse({ ok: true, result });
        }
        case "passkeyDetach": {
          await passkeyProxy.detach();
          return sendResponse({ ok: true });
        }
        case "generatedFilled": {
          const tabId = sender.tab?.id;
          if (tabId == null || typeof msg.password !== "string" || !msg.password || msg.password.length > 256) return sendResponse({ ok: false });
          clearTimeout(generatedByTab.get(tabId)?.timer);
          generatedByTab.set(tabId, { password: msg.password, at: Date.now(), timer: setTimeout(() => dropGenerated(tabId), GENERATED_HOLD_MS) });
          refreshActiveTab();
          return sendResponse({ ok: true });
        }
        case "inlineLogins": {
          // keyed to sender.url not the top tab
          const frameUrl = sender.url;
          if (!frameUrl) return sendResponse({ ok: false, error: "no frame" });
          await ensureConnected();
          if (client.state === State.NoHelper) return sendResponse({ ok: true, locked: false, logins: [], unavailable: true });
          if (!client.ready) return sendResponse({ ok: true, locked: true, logins: [] });
          try {
            const logins = await siteLogins(sender.tab?.id, frameUrl);
            sendResponse({
              ok: true,
              locked: false,
              logins: publicLogins(uniqueByUsername(await orderByUse(hostnameOf(frameUrl), logins))),
            });
          } catch {
            sendResponse({ ok: true, locked: false, logins: [], unavailable: true });
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
            return sendResponse({ ok: false, error: t("refuseFillHttp") });
          }
          const code = await resolveOneTimeCode(sender.tab.id, Number(msg.id));
          // the frame stays silent when its code field is gone
          const resp = await chrome.tabs
            .sendMessage(sender.tab.id, { type: "fillOtp", code, expectedHost: host }, { frameId })
            .catch(() => null);
          if (!resp?.filled) return sendResponse({ ok: false, filled: false, error: t("codeFieldNotFound") });
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
            return sendResponse({ ok: false, error: t("refuseFillHttp") });
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
              error: t("passwordReadFailed"),
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
            return sendResponse({ ok: false, filled: false, error: t("loginFormNotFound") });
          }
          const filled = !!resp?.filled;
          if (filled) {
            recordUse(host, cred.username).catch(() => {});
            lastFillByTab.set(sender.tab.id, { host, username: cred.username });
            sendResponse({ ok: true, filled: true });
            break;
          }
          const status = resp?.error || "no fields";
          console.info("[PassBridge] inlineFill", { status, host });
          sendResponse({
            ok: false,
            filled: false,
            error: status === "no fields" ? t("couldntFillPageBg") : status,
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
            return sendResponse({ ok: false, error: t("refuseSaveHttp") });
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
          const target = await pickSaveTarget({ host, existing, detected, generated, newPwCtx });
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
            generated,
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
          const draftHost = offer.host || hostnameOf(offer.frameUrl) || "";
          sendResponse({
            ok: true,
            username: offer.target || "",
            password: offer.password,
            site: draftHost,
            agentOffer: agentOfferFor(await getSettings(), draftHost, offer.generated),
            canNewSheet: client.canOpenPasswordsAppToNewPasswordSheet === true,
          });
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
          // the bar shows the website too; a changed one is checked by the same gate as every save
          let url = offer.frameUrl;
          const site = typeof msg.site === "string" ? msg.site.trim() : "";
          if (site && site.toLowerCase() !== String(offer.host || hostnameOf(offer.frameUrl)).toLowerCase()) {
            const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`;
            let ok = false;
            try { ok = !!new URL(full).hostname && (await isFillUrlAllowed(full)); } catch {}
            if (!ok) return sendResponse({ ok: false, error: t("errSiteInvalid") });
            url = full;
          }
          if (msg.asNew === true && client.canOpenPasswordsAppToNewPasswordSheet) {
            // Passwords' own new-login sheet is the reliable way to force a separate entry
            client.launchPasswordsApp({ newPasswordUrl: url });
          } else {
            await client.saveLogin(offer.tabId, url, username, password);
          }
          // only our own bar may ask, and only while the offer still holds in the current settings
          if (msg.allowAgent === true && (sender.url || "").startsWith(chrome.runtime.getURL("overlay/save-bar.html"))) {
            try {
              const settings = await getSettings();
              const agentHost = agentHostFor(hostnameOf(url) || offer.host);
              if (agentOfferFor(settings, agentHost, false).show) {
                const { agentAllowlist } = await settingsStore().get({ agentAllowlist: settings.agentAllowlist });
                await settingsStore().set({ agentAllowlist: addToAllowlist(agentAllowlist, agentHost) });
              }
            } catch {}
          }
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

        // popup flow: the setup key is held here, the popup only ever sees issuer and account
        case "totpScanTab": {
          const tab = await activeTab();
          if (!tab?.id || !/^https?:/i.test(tab.url || "")) return sendResponse({ ok: false, error: t("totpOpenQrFirst") });
          let dataUrl;
          try {
            dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          } catch {
            return sendResponse({ ok: false, error: t("couldntCapture") });
          }
          await ensureOffscreen();
          const decoded = await chrome.runtime.sendMessage({ type: "offscreenDecodeQr", dataUrl, rect: { x: 0, y: 0, w: 1, h: 1, dpr: 1, whole: true } });
          if (!decoded?.ok) return sendResponse({ ok: false, error: decoded?.error || t("qrUnreadableBg") });
          const parsed = (decoded.values || []).map(parseOtpAuth).find(Boolean);
          if (!parsed) {
            return sendResponse({
              ok: false,
              error: (decoded.values || []).length
                ? t("totpQrNotLink")
                : t("totpQrNotVisible"),
            });
          }
          totpOffers.set(tab.id, { at: Date.now(), uri: parsed.uri, pageUrl: tab.url, issuer: parsed.issuer, account: parsed.account, usernames: [] });
          sendResponse({ ok: true, issuer: parsed.issuer, account: parsed.account });
          break;
        }

        case "totpPaste": {
          const tab = await activeTab();
          if (!tab?.id || !/^https?:/i.test(tab.url || "")) return sendResponse({ ok: false, error: t("totpOpenPageFirst") });
          const parsed = parseSetupInput(msg.text, hostnameOf(tab.url) || "");
          if (!parsed) return sendResponse({ ok: false, error: t("totpNotSetupKey") });
          totpOffers.set(tab.id, { at: Date.now(), uri: parsed.uri, pageUrl: tab.url, issuer: parsed.issuer, account: parsed.account, usernames: [] });
          sendResponse({ ok: true, issuer: parsed.issuer, account: parsed.account });
          break;
        }

        case "totpAdd": {
          const tab = await activeTab();
          const offer = tab?.id != null ? totpOffers.get(tab.id) : null;
          if (!offer || !secretFresh(offer)) return sendResponse({ ok: false, error: t("totpScanAgain") });
          await ensureConnected();
          if (!client.ready || !client.canSetUpTotp) return sendResponse({ ok: false, error: t("totpUnsupported") });
          const username = String(msg.username || "").trim();
          const labelled = withAccount(offer.uri, { username, issuer: offer.issuer || hostnameOf(offer.pageUrl) });
          if (labelled) offer.uri = labelled;
          offer.handedOff = true;
          const res = await handOffTotp(offer);
          // the protocol carries the page and a labelled link, not an account id: Passwords asks which login
          sendResponse({ ...res, username, targeted: false });
          break;
        }

        case "totpCopyKey": {
          const tab = await activeTab();
          const offer = tab?.id != null ? totpOffers.get(tab.id) : null;
          if (tab?.id != null) totpOffers.delete(tab.id);
          const secret = offer?.handedOff && secretFresh(offer) ? otpAuthSecret(offer.uri) : "";
          if (!secret) return sendResponse({ ok: false, error: t("totpKeyGoneAdd") });
          await copyText(secret);
          sendResponse({ ok: true, copied: true });
          break;
        }

        case "copyTotpKey": {
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          const offer = sender.tab?.id != null ? totpOffers.get(sender.tab.id) : null;
          if (sender.tab?.id != null) totpOffers.delete(sender.tab.id);
          const secret = offer?.handedOff && secretFresh(offer) ? otpAuthSecret(offer.uri) : "";
          if (!secret) return sendResponse({ ok: false, error: t("totpKeyGoneScan") });
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
          if (!client.ready) return sendResponse({ ok: false, error: t("locked") });
          const logins = uniqueByUsername(await orderByUse(hostnameOf(url), await siteLogins(tab.id, url)));
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
            if (!text) return sendResponse({ ok: false, error: t("passwordReadLoginFailed") });
          } else if (msg.field === "otp") {
            text = await resolveOneTimeCode(tab.id, Number(msg.id));
          }
          if (!text) return sendResponse({ ok: false, error: t("nothingToCopy") });
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
          sendResponse({ ok: true, os: platformOs, label: uiDeviceLabel(platformOs, t) });
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
            label: uiDeviceLabel(platformOs, t),
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
          const { rows, requiresAuth } = await listOneTimeCodes(tab.id, 0, frameUrlsFor({ url }), { listOnly: !!msg.listOnly });
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

        // popup only (not in CONTENT_ALLOWED): always a new login, never an update of an existing one
        case "popupAddLogin": {
          const site = typeof msg.site === "string" ? msg.site.trim() : "";
          const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`;
          let ok = false;
          try { ok = !!site && !!new URL(full).hostname && (await isFillUrlAllowed(full)); } catch {}
          if (!ok) return sendResponse({ ok: false, error: t("errSiteInvalid") });
          if (typeof msg.password !== "string" || !msg.password) return sendResponse({ ok: false, error: t("errTypePassword") });
          const tab = await activeTab();
          if (tab?.id == null) return sendResponse({ ok: false, error: t("errOpenSiteFirst") });
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: false, error: t("errUnlockFirst") });
          const username = typeof msg.username === "string" ? msg.username.trim() : "";
          const lookup = async () => (await client.getLoginNamesForURL(tab.id, full)).filter((l) => !isPasskeyLogin(l));
          let before = 0;
          try { before = countLogins(await lookup(), username); } catch {}
          // a same-username login already matches (a sibling tenant): the Passwords new-login sheet adds it without an update prompt
          if (useNewLoginSheet({ username, before, canSheet: client.canOpenPasswordsAppToNewPasswordSheet })) {
            client.launchPasswordsApp({ newPasswordUrl: full });
            return sendResponse({ ok: true, sheet: true, note: t("addLoginInPasswordsApp") });
          }
          try {
            await client.saveLogin(tab.id, full, username, msg.password);
          } catch (e) {
            return sendResponse({ ok: false, error: String(e?.message || e) });
          }
          const result = await confirmLoginAdded({ lookup, username, before, isReady: () => client.ready });
          if (result === "saved") return sendResponse({ ok: true, saved: true });
          if (result === "locked") return sendResponse({ ok: false, error: t("errUnlockFirst") });
          sendResponse({ ok: false, error: t("errLoginNotSaved") });
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
          const ordered = publicLogins(uniqueByUsername(await orderByUse(hostnameOf(tab.url), logins)));
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
            return sendResponse({ ok: false, filled: false, error: t("noSavedPasswordForLogin") });
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
            recordUse(pageHost, cred.username).catch(() => {});
            lastFillByTab.set(tab.id, { host: pageHost, username: cred.username });
          }
          sendResponse(filled
            ? { ok: true, filled: true }
            : { ok: false, filled: false, error: resp?.error || t("loginFormNotFound") });
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
            if (!cred) return sendResponse({ ok: false, refilled: false, error: t("noSavedPasswordForLogin") });
            pwCacheSet(host, cred);
            const resp = await sendFill(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              expectedHost: host,
            });
            if (!resp?.filled) {
              return sendResponse({ ok: false, refilled: false, error: resp?.error || t("loginFormNotFound") });
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

        case "updaterAvailable":
          sendResponse({ ok: await updaterAvailable() });
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
  isLocalDevHost,
  siteLogins,
  uniqueByUsername,
  fillLoginOnTab,
});
