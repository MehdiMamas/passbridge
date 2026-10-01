// alarm keep-alive holds the MV3 worker so the PIN isnt re-prompted every idle-out

import { State, setDeviceLabel } from "./apple/protocol.js";
import { createClient } from "./session/create-client.js";
import { labelForOs } from "./apple/os-label.js";
import { getSettings, hostBlocked } from "./settings.js";
import { INLINE_MENU_PORTS, portKeyForTab } from "./adapter/ports.js";
import { generateLoginFillScript } from "./adapter/fill-script.js";
import { generateApplePassword } from "./password-generate.js";
import { otpAuthSecret, parseOtpAuth } from "./otpauth.js";
import { passwordSearchSteps } from "./session/password-search.js";

const client = createClient();
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
  }
  broadcast({ type: "state", state: s });
});

// the pairing-window reader stays installed, but nothing drives it on its own
const AUTOPAIR_HOST = "com.passbridge.autopair";

function autoPairMsg(body) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(AUTOPAIR_HOST, body, (r) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : r || { ok: false, error: "no reply" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) });
    }
  });
}

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

// apple walks the whole parent chain via webNavigation, the top URL covers a same-site iframe without another permission
function frameUrlsFor(sender) {
  const urls = [];
  for (const u of [sender.url, sender.tab?.url]) {
    if (u && /^https?:/i.test(u) && !urls.includes(u)) urls.push(u);
  }
  return urls;
}

// never the code itself at list time
function otpRow(e, i) {
  return { id: i, source: e.source, username: e.username, domain: e.domain };
}

async function listOneTimeCodes(tabId, frameId, frameUrls) {
  const { entries, requiresAuth } = await client.getOneTimeCodes(tabId, frameId, frameUrls);
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
        existing = (await client.getLoginNamesForURL(s.tabId, s.frameUrl))
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

// hostname first, then the full path when the helper supports it.
// a miss then uses websites from this frame's own login list, never a site the page named.
async function readPasswordForFrame(tabId, frameUrl, username) {
  const host = registrableHost(frameUrl);
  const pathUrl = client.capabilities?.supportsSubURLs ? framePathUrl(frameUrl) : null;
  const tried = [];
  let cred = null;
  const run = async (steps) => {
    for (const step of steps) {
      const key = `${step.envelope}\n${step.search}`;
      if (tried.includes(key)) continue;
      tried.push(key);
      cred = await client.getPasswordForLoginName(
        tabId,
        frameUrl,
        { username },
        step.search === host ? undefined : step.search,
        step.envelope === host ? undefined : step.envelope,
      );
      if (cred) return true;
    }
    return false;
  };
  if (!(await run(passwordSearchSteps(host, [], pathUrl)))) {
    const logins = await client.getLoginNamesForURL(tabId, frameUrl);
    const match = (logins || []).find((l) => normUsername(l.username) === normUsername(username));
    await run(passwordSearchSteps(host, match?.sites, pathUrl));
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
ensureConnected();

function suppressChromeAutofill() {
  const svc = chrome.privacy?.services;
  if (!svc?.passwordSavingEnabled) return;
  // credit-card autofill is never touched, google pay keeps working
  chrome.storage?.local?.get({ suppressSaveBubble: true, suppressAddressAutofill: false }, (o) => {
    if (chrome.runtime.lastError) return;
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
chrome.runtime.onInstalled.addListener(suppressChromeAutofill);
chrome.runtime.onStartup.addListener(suppressChromeAutofill);
suppressChromeAutofill();

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

function registrableHost(u) {
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

// only these from a content script, none returns a password to the page
const CONTENT_ALLOWED = new Set([
  "inlineLogins",
  "inlineFill",
  "inlineOneTimeCodes",
  "inlineFillOneTimeCode",
  "requestChallenge",
  "verifyPin",
  "resolveSave",
  "getPlatform",
  "confirmSave",
  "neverSave",
  "dismissSave",
  "confirmTotp",
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

chrome.runtime.onConnect.addListener((port) => {
  if (!INLINE_MENU_PORTS.has(port.name)) {
    try { port.disconnect(); } catch {}
    return;
  }
  const tabId = port.sender?.tab?.id ?? 0;
  const portKey = portKeyForTab(tabId);
  port.postMessage({ command: "init", portKey });
  port.onMessage.addListener((msg) => {
    if (!msg || msg.portKey !== portKey) return;
    if (msg.command !== "fieldRect") return;
    const rect = msg.rect || {};
    port.postMessage({
      command: "position",
      portKey,
      button: { top: rect.y, left: (rect.x || 0) + Math.max(0, (rect.width || 0) - 28), width: 20, height: 20 },
      list: { top: (rect.y || 0) + (rect.height || 0) + 2, left: rect.x || 0, width: Math.max(rect.width || 0, 200) },
    });
  });
});

async function cycleFill(tab) {
  await ensureConnected();
  if (!client.ready || !tab?.url || tab.id == null) return;
  const host = registrableHost(tab.url);
  if (!/^https:\/\//i.test(tab.url) && !isLocalDevHost(host)) return;
  let logins = [];
  try {
    logins = uniqueByUsername(orderByMru(host, await client.getLoginNamesForURL(tab.id, tab.url)));
  } catch {
    return;
  }
  if (!logins.length) return;
  const i = cycleByTab.get(tab.id) || 0;
  const login = logins[i % logins.length];
  cycleByTab.set(tab.id, i + 1);
  let cred = pwCacheGet(host, login.username);
  if (!cred) {
    cred = (await readPasswordForFrame(tab.id, tab.url, login.username)).cred;
    if (cred) pwCacheSet(host, cred);
  }
  if (!cred) return;
  const script = generateLoginFillScript({
    username: cred.username,
    password: cred.password,
    usernameOpid: "username",
    passwordOpid: "password",
  });
  const resp = await chrome.tabs.sendMessage(tab.id, {
    type: "fill",
    username: cred.username,
    password: cred.password,
    expectedHost: host,
    script,
  });
  if (resp?.filled) {
    recordMru(host, cred.username);
    lastFillByTab.set(tab.id, { host, username: cred.username });
  }
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

async function copyText(text) {
  const settings = await getSettings();
  const clearMs = Number(settings.clipboardClearMs) || 10000;
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ type: "offscreenCopy", text: text || "", clearMs }).catch(() => {});
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

async function handOffTotp(offer) {
  const secret = otpAuthSecret(offer?.uri);
  const detail = secret
    ? "Setup key copied. Paste it in Passwords if the app did not take it."
    : "Couldn't copy a setup key.";
  try {
    if (secret) await copyText(secret);
    await ensureConnected();
    client.launchPasswordsApp({ totpUri: offer.uri, totpPageUrl: offer.pageUrl });
  } catch {
    return { ok: true, copied: !!secret, filled: false, detail };
  }
  return { ok: true, copied: !!secret, filled: false, detail };
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
  if (!rect || rect.w < 8 || rect.h < 8) {
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
    logins = uniqueByUsername(await client.getLoginNamesForURL(tab.id, tab.url));
  } catch {
    logins = [];
  }
  const usernames = logins.map((login) => login.username || "(no username)").slice(0, 8);
  totpOffers.set(tab.id, {
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

async function updateBadge(tabId) {
  try {
    const settings = await getSettings();
    if (!settings.enableBadge || tabId == null) {
      if (tabId != null) chrome.action.setBadgeText({ text: "", tabId });
      return;
    }
    if (!client.ready) {
      chrome.action.setBadgeText({ text: "", tabId });
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !/^https?:/i.test(tab.url)) {
      chrome.action.setBadgeText({ text: "", tabId });
      return;
    }
    const logins = uniqueByUsername(await client.getLoginNamesForURL(tabId, tab.url));
    const n = logins.length;
    chrome.action.setBadgeText({ text: n > 9 ? "9+" : n ? String(n) : "", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#0a84ff", tabId });
  } catch {}
}

let menuLogins = [];

async function rebuildContextMenu(tab) {
  const settings = await getSettings();
  chrome.contextMenus.removeAll(() => {
    if (!settings.enableContextMenu || chrome.runtime.lastError) return;
    chrome.contextMenus.create({ id: "pb-root", title: "PassBridge", contexts: ["editable", "page", "image"] });
    chrome.contextMenus.create({ id: "pb-fill", parentId: "pb-root", title: "Autofill login", contexts: ["editable", "page"] });
    chrome.contextMenus.create({ id: "pb-user", parentId: "pb-root", title: "Copy username", contexts: ["editable", "page"] });
    chrome.contextMenus.create({ id: "pb-pass", parentId: "pb-root", title: "Copy password", contexts: ["editable", "page"] });
    chrome.contextMenus.create({ id: "pb-otp", parentId: "pb-root", title: "Copy verification code", contexts: ["editable", "page"] });
    chrome.contextMenus.create({ id: "pb-gen", parentId: "pb-root", title: "Generate password", contexts: ["editable", "page"] });
    chrome.contextMenus.create({ id: "pb-gen-copy", parentId: "pb-root", title: "Generate password and copy", contexts: ["editable", "page"] });
    chrome.contextMenus.create({ id: "pb-qr-image", parentId: "pb-root", title: "Scan this image for a verification code", contexts: ["image"] });
    if (!client.ready || !tab?.url) return;
    client.getLoginNamesForURL(tab.id, tab.url).then((logins) => {
      menuLogins = uniqueByUsername(orderByMru(registrableHost(tab.url), logins || [])).slice(0, 8);
      menuLogins.forEach((login, i) => {
        chrome.contextMenus.create({
          id: `pb-login-${i}`,
          parentId: "pb-fill",
          title: login.username || "(no username)",
          contexts: ["editable", "page"],
        });
      });
    }).catch(() => {});
  });
}

function clearBadges() {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs || []) {
      if (t.id != null) chrome.action.setBadgeText({ text: "", tabId: t.id });
    }
  });
}

chrome.commands?.onCommand.addListener(async (command) => {
  if (command === "lock-vault") {
    await forgetSecrets();
    client.disconnect();
    menuLogins = [];
    clearBadges();
    rebuildContextMenu(await activeTab());
    return;
  }
  const tab = await activeTab();
  if (tab?.id == null) return;
  if (command === "fill-login") chrome.tabs.sendMessage(tab.id, { type: "shortcut" }).catch(() => {});
  else if (command === "autofill-login") await cycleFill(tab);
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "pb-gen") {
    chrome.tabs.sendMessage(tab.id, { type: "generatePassword" }).catch(() => {});
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
    const login = menuLogins[Number(String(info.menuItemId).slice("pb-login-".length))];
    if (login) {
      cycleByTab.set(tab.id, menuLogins.indexOf(login));
      await cycleFill(tab);
    }
    return;
  }
  if (info.menuItemId === "pb-fill") {
    await cycleFill(tab);
    return;
  }
  if (!client.ready || !tab.url) return;
  const host = registrableHost(tab.url);
  let logins = [];
  try {
    logins = uniqueByUsername(orderByMru(host, await client.getLoginNamesForURL(tab.id, tab.url)));
  } catch { return; }
  const login = logins[0];
  if (!login) return;
  if (info.menuItemId === "pb-user") await copyText(login.username || "");
  else if (info.menuItemId === "pb-pass") {
    const cred = await client.getPasswordForLoginName(tab.id, tab.url, { username: login.username });
    if (cred?.password) await copyText(cred.password);
  } else if (info.menuItemId === "pb-otp") {
    try {
      const { rows } = await listOneTimeCodes(tab.id, 0, [tab.url]);
      if (rows[0]) await copyText(await resolveOneTimeCode(tab.id, rows[0].id));
    } catch {}
  }
});

chrome.tabs?.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId);
  chrome.tabs.get(tabId).then((tab) => rebuildContextMenu(tab)).catch(() => {});
});
chrome.tabs?.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete") {
    updateBadge(tabId);
    rebuildContextMenu(tab);
    const offer = saveOffers.get(tabId);
    if (offer && Date.now() - offer.at < 20000) {
      chrome.tabs.sendMessage(
        tabId,
        { type: "showSaveBar", username: offer.target, update: offer.update },
        { frameId: 0 },
      ).catch(() => {});
    }
  }
});
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enableBadge) {
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs || []) if (t.id != null) updateBadge(t.id);
    });
  }
  if (changes.enableContextMenu || changes.enableBadge) {
    activeTab().then((tab) => rebuildContextMenu(tab)).catch(() => {});
  }
});
try {
  chrome.webRequest?.onCompleted.addListener((details) => {
    if (details.type !== "main_frame") return;
    if (!saveOffers.has(details.tabId)) return;
    const method = String(details.method || "").toUpperCase();
    if (!["POST", "PUT", "PATCH"].includes(method)) return;
    if (details.statusCode >= 400) {
      saveOffers.delete(details.tabId);
      chrome.tabs.sendMessage(details.tabId, { type: "hideSaveBar" }).catch(() => {});
    }
  }, { urls: ["<all_urls>"] });
} catch {}

chrome.tabs?.onRemoved.addListener((tabId) => {
  totpOffers.delete(tabId);
  saveOffers.delete(tabId);
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
          if (!client.ready) return sendResponse({ ok: true, locked: true, logins: [] });
          try {
            const logins = await client.getLoginNamesForURL(sender.tab?.id, frameUrl);
            sendResponse({
              ok: true,
              locked: false,
              logins: uniqueByUsername(orderByMru(registrableHost(frameUrl), logins)),
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
          const host = registrableHost(frameUrl);
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          const code = await resolveOneTimeCode(sender.tab.id, Number(msg.id));
          const resp = await chrome.tabs.sendMessage(
            sender.tab.id,
            { type: "fillOtp", code, expectedHost: host },
            { frameId },
          );
          if (resp?.filled && (await getSettings()).copyTotpAfterFill) await copyText(code);
          sendResponse({ ok: true, filled: !!resp?.filled });
          break;
        }

        case "inlineFill": {
          // frameId scopes the fill to the requesting frame, never broadcast (confused deputy)
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const host = registrableHost(frameUrl);
          const isLocalDev =
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "[::1]" ||
            host?.endsWith(".localhost") ||
            host?.endsWith(".test");
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDev) {
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
            const error = String(e?.message ?? e);
            console.info("[PassBridge] inlineFill", { status: "fill message failed", host, error });
            return sendResponse({ ok: false, filled: false, error });
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
          const host = registrableHost(frameUrl);
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDevHost(host)) {
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
            existing = (await client.getLoginNamesForURL(sender.tab.id, frameUrl))
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

        case "confirmSave": {
          const offer = sender.tab?.id != null ? saveOffers.get(sender.tab.id) : null;
          if (!secretFresh(offer)) {
            if (sender.tab?.id != null) saveOffers.delete(sender.tab.id);
            return sendResponse({ ok: false, error: "nothing to save" });
          }
          saveOffers.delete(sender.tab.id);
          await ensureConnected();
          await client.saveLogin(offer.tabId, offer.frameUrl, offer.target, offer.password);
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
          if (sender.tab?.id != null) totpOffers.delete(sender.tab.id);
          if (!offer) return sendResponse({ ok: false, error: "nothing to add" });
          sendResponse(await handOffTotp(offer));
          break;
        }

        case "dismissTotp": {
          if (sender.tab?.id != null) totpOffers.delete(sender.tab.id);
          sendResponse({ ok: true });
          break;
        }

        case "neverSave": {
          const host = registrableHost(sender.url || "");
          if (sender.tab?.id != null) saveOffers.delete(sender.tab.id);
          if (host) {
            const settings = await getSettings();
            const excludedDomains = Array.from(new Set([...(settings.excludedDomains || []), host]));
            await chrome.storage.local.set({ excludedDomains });
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
          const logins = uniqueByUsername(await client.getLoginNamesForURL(tab.id, url));
          sendResponse({ ok: true, host: registrableHost(url), logins });
          break;
        }

        case "copyField": {
          const tab = await activeTab();
          if (!tab?.url || tab.id == null) return sendResponse({ ok: false, error: "no tab" });
          const url = httpUrl(msg.url) || tab.url;
          let text = "";
          if (msg.field === "username") text = msg.username || "";
          else if (msg.field === "password") {
            const cred = await client.getPasswordForLoginName(tab.id, url, { username: msg.username });
            text = cred?.password || "";
          } else if (msg.field === "otp") {
            text = await resolveOneTimeCode(tab.id, Number(msg.id));
          }
          if (!text) return sendResponse({ ok: false, error: "nothing to copy" });
          await copyText(text);
          sendResponse({ ok: true });
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
            caps: {
              oneTimeCodes: client.canFillOneTimeCodes,
              newPasswordSheet: client.canOpenPasswordsAppToNewPasswordSheet,
              setUpTotp: client.canSetUpTotp,
            },
          });
          break;

        case "autoPairCheck": {
          const r = await autoPairMsg({ action: "check" });
          sendResponse(r);
          break;
        }

        case "getOneTimeCodes": {
          const tab = await activeTab();
          const url = httpUrl(msg.url) || tab?.url;
          if (!tab?.id || !url) return sendResponse({ ok: false, error: "no active tab" });
          if (!client.ready) return sendResponse({ ok: true, rows: [] });
          if (!client.canFillOneTimeCodes) return sendResponse({ ok: true, supported: false, rows: [] });
          const { rows, requiresAuth } = await listOneTimeCodes(tab.id, 0, frameUrlsFor({ url, tab }));
          sendResponse({ ok: true, supported: true, rows, requiresAuth });
          break;
        }

        case "fillOneTimeCode": {
          // every frame gets it, only the one with a code field acts. value returned so the popup can show it if none did
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const host = registrableHost(tab.url);
          if (!/^https:\/\//i.test(tab.url) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          const code = await resolveOneTimeCode(tab.id, Number(msg.id));
          let filled = false;
          try {
            const frames = await new Promise((resolve) =>
              chrome.tabs.sendMessage(tab.id, { type: "fillOtp", code, expectedHost: host }, (r) => {
                void chrome.runtime.lastError;
                resolve(r);
              }),
            );
            filled = !!frames?.filled;
          } catch (_) {}
          if (filled && (await getSettings()).copyTotpAfterFill) await copyText(code);
          sendResponse({ ok: true, filled, code });
          break;
        }

        case "openPasswordsApp": {
          const tab = await activeTab();
          const url = httpUrl(msg.url) || (tab?.url && /^https?:/i.test(tab.url) ? tab.url : undefined);
          await ensureConnected();
          if (msg.mode === "totp") {
            if (!msg.uri || !/^(apple-)?otpauth:\/\//i.test(msg.uri)) return sendResponse({ ok: false, error: "no otpauth URI" });
            const parsed = parseOtpAuth(msg.uri);
            let usernames = [];
            if (tab?.id && url && client.ready) {
              try {
                usernames = uniqueByUsername(await client.getLoginNamesForURL(tab.id, url))
                  .map((login) => login.username || "")
                  .filter(Boolean)
                  .slice(0, 8);
              } catch {}
            }
            sendResponse(await handOffTotp({
              uri: msg.uri,
              pageUrl: url,
              issuer: parsed?.issuer || "",
              account: parsed?.account || "",
              usernames,
            }));
            break;
          } else if (msg.mode === "new") {
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
          const logins = await client.getLoginNamesForURL(tab.id, tab.url);
          sendResponse({ ok: true, logins: uniqueByUsername(orderByMru(registrableHost(tab.url), logins)) });
          break;
        }

        case "fillOnPage": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const pageHost = registrableHost(tab.url);
          const isLocalDev =
            pageHost === "localhost" ||
            pageHost === "127.0.0.1" ||
            pageHost === "[::1]" ||
            pageHost?.endsWith(".localhost") ||
            pageHost?.endsWith(".test");
          if (!/^https:\/\//i.test(tab.url) && !isLocalDev) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          const credUrl = httpUrl(msg.url) || tab.url;
          const credHost = registrableHost(credUrl);
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
          const resp = await chrome.tabs.sendMessage(tab.id, {
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
          const host = tab?.url ? registrableHost(tab.url) : null;
          if (!entry || !host || entry.host !== host) {
            return sendResponse({ ok: true, refilled: false, reason: "none" });
          }
          try {
            const cred = await client.getPasswordForLoginName(tab.id, tab.url, { username: entry.username });
            if (!cred) return sendResponse({ ok: false, refilled: false, error: "No saved password for that login." });
            pwCacheSet(host, cred);
            const resp = await chrome.tabs.sendMessage(tab.id, {
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
