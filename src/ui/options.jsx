import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SETTINGS_AREA, SETTINGS_DEFAULTS as DEFAULTS, settingsStore } from "../settings.js";
import { domainLines } from "../session/agent-allow.js";
import { UPDATE_PAGE } from "../update/check.js";
import { updaterAvailable } from "../update/install.js";
import { isWindows } from "../update/platform.js";
import { parseExport } from "../passkeys/import.js";
import { helperView, passkeysView, policyMessage, shouldRecheck, tabFromHash } from "./options-model.js";
import { applyDocumentLanguage, t } from "../i18n/runtime.js";
import { useLocale } from "../i18n/use.jsx";
import { OptionsScreen } from "./options-screen.jsx";
import { followTheme } from "./page-theme.js";

const LIST_KEYS = ["blockedDomains", "excludedDomains", "agentAllowlist"];
const BLUR_SAVED_LIST = "agentAllowlist";
const IS_WINDOWS = isWindows();
const IS_EDGE = !!/** @type {Navigator & { userAgentData?: { brands?: { brand: string }[] } }} */ (navigator).userAgentData?.brands?.some((b) => b.brand === "Microsoft Edge");

function OptionsApp() {
  const locale = useLocale();
  const [settings, setSettings] = useState(/** @type {import("./options-screen.jsx").OptionsSettings} */ (DEFAULTS));
  const [isLoaded, setIsLoaded] = useState(false);
  const [lists, setLists] = useState(() => Object.fromEntries(LIST_KEYS.map((k) => [k, ""])));
  const [agentLog, setAgentLog] = useState(/** @type {{ t: number, op: string, host: string, username: string, result: string }[]} */ ([]));
  const [relay, setRelay] = useState("");
  const [passkeyOn, setPasskeyOn] = useState(false);
  const [passkeyNote, setPasskeyNote] = useState("");
  const [allSites, setAllSites] = useState(true);
  const [stayUnlocked, setStayUnlocked] = useState(false);
  const [syncSteps, setSyncSteps] = useState([]);
  const [passkeyProgress, setPasskeyProgress] = useState(/** @type {{ done: number, total: number } | null} */ (null));
  const [passkeyResults, setPasskeyResults] = useState(/** @type {{ label: string, status: string, reason?: string }[]} */ ([]));
  const [tab, setTab] = useState(() => tabFromHash(location.hash));
  const [helpers, setHelpers] = useState(/** @type {{ policy: import("./options-model.js").HelperState, updater: import("./options-model.js").HelperState }} */ ({ policy: "checking", updater: "checking" }));
  const [policy, setPolicy] = useState({ hidden: false, message: "" });
  const [bubble, setBubble] = useState({ shown: false, checked: false, disabled: true });
  const [address, setAddress] = useState({ shown: false, checked: false, disabled: true });
  const [isMruCleared, setIsMruCleared] = useState(false);
  const listsRef = useRef(lists);
  const isBlurListDirty = useRef(false);
  listsRef.current = lists;

  useEffect(() => {
    settingsStore().get(DEFAULTS, (saved) => {
      const next = /** @type {import("./options-screen.jsx").OptionsSettings} */ ({ ...DEFAULTS, ...saved });
      if (!Number(next.clipboardClearMs)) {
        next.clipboardClearMs = DEFAULTS.clipboardClearMs;
        settingsStore().set({ clipboardClearMs: next.clipboardClearMs });
      }
      setSettings(next);
      setIsLoaded(true);
      setLists(Object.fromEntries(LIST_KEYS.map((k) => [k, (next[k] || []).join("\n")])));
    });
    chrome.storage.local.get({ agentLog: [] }, (o) => setAgentLog(Array.isArray(o.agentLog) ? o.agentLog : []));
    /** @param {Record<string, { newValue?: any }>} changes @param {string} area */
    const onLog = (changes, area) => {
      if (area === "local" && changes.agentLog) setAgentLog(changes.agentLog.newValue || []);
    };
    chrome.storage.onChanged.addListener(onLog);
    // the save bar can add a site while this page is open; take it in so a later save never writes the old list back
    /** @param {Record<string, { newValue?: any }>} changes @param {string} area */
    const onAllowlist = (changes, area) => {
      if (area !== SETTINGS_AREA || !changes.agentAllowlist || isBlurListDirty.current) return;
      const next = changes.agentAllowlist.newValue || [];
      setSettings((s) => ({ ...s, agentAllowlist: next }));
      setLists((l) => ({ ...l, agentAllowlist: next.join("\n") }));
    };
    chrome.storage.onChanged.addListener(onAllowlist);
    try {
      chrome.storage.session.get({ agentRelay: "" }, (o) => setRelay(/** @type {string} */ (o.agentRelay || "")));
    } catch {}
    /** @param {Record<string, { newValue?: any }>} changes @param {string} area */
    const onRelay = (changes, area) => {
      if (area === "session" && changes.agentRelay) setRelay(changes.agentRelay.newValue || "");
    };
    chrome.storage.onChanged.addListener(onRelay);
    readPasskeySetting();
    sendPolicy("get").then((r) => applyPolicy(r, policyMessage(r, false)));
    updaterAvailable().then((has) => setHelpers((h) => ({ ...h, updater: has ? "present" : "missing" })));
    readPrivacy("passwordSavingEnabled", setBubble);
    readPrivacy("autofillAddressEnabled", setAddress);
    const onHash = () => {
      saveBlurList();
      setTab(tabFromHash(location.hash));
    };
    const onPageHide = () => {
      saveBlurList();
      flushSettings();
    };
    addEventListener("hashchange", onHash);
    addEventListener("pagehide", onPageHide);
    return () => {
      chrome.storage.onChanged.removeListener(onLog);
      chrome.storage.onChanged.removeListener(onAllowlist);
      chrome.storage.onChanged.removeListener(onRelay);
      removeEventListener("hashchange", onHash);
      removeEventListener("pagehide", onPageHide);
      onPageHide();
    };
  }, []);

  // recheck the helpers when the user comes back to this page, e.g. after running install.cmd
  const lastCheck = useRef(Date.now());
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible" || !shouldRecheck(lastCheck.current, Date.now())) return;
      lastCheck.current = Date.now();
      sendPolicy("get").then((r) => applyPolicy(r, policyMessage(r, false)));
      updaterAvailable().then((has) => setHelpers((h) => ({ ...h, updater: has ? "present" : "missing" })));
    };
    document.addEventListener("visibilitychange", recheck);
    addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      removeEventListener("focus", recheck);
    };
  }, []);

  function readPasskeySetting() {
    try {
      chrome.storage.local.get({ passkeyStore: false, passkeysAllSites: true, passkeysStayUnlocked: false }, (o) => {
        setPasskeyOn(o.passkeyStore === true);
        setAllSites(o.passkeysAllSites !== false);
        setStayUnlocked(o.passkeysStayUnlocked === true);
      });
    } catch {}
  }

  /** @param {boolean} on */
  async function onPasskeyToggle(on) {
    setPasskeyNote("");
    if (on) {
      // webAuthenticationProxy is a required permission (Chrome refuses it as optional, #226);
      // holding it does nothing until this setting turns the proxy on
      await chrome.storage.local.set({ passkeyStore: true });
      setPasskeyOn(true);
      return;
    }
    await chrome.storage.local.set({ passkeyStore: false });
    setPasskeyOn(false);
    try {
      await chrome.runtime.sendMessage({ type: "passkeyDetach" });
    } catch {}
  }

  /** @param {boolean} on */
  async function onAllSites(on) {
    setAllSites(on);
    await chrome.storage.local.set({ passkeysAllSites: on });
  }

  /** @param {boolean} on */
  async function onStayUnlocked(on) {
    setStayUnlocked(on);
    await chrome.storage.local.set({ passkeysStayUnlocked: on });
  }

  async function onSyncAll() {
    const res = await chrome.runtime.sendMessage({ type: "passkeySyncAll" });
    setSyncSteps(res?.steps || []);
  }

  /** @param {File | undefined} file */
  async function onPasskeyPick(file) {
    if (!file) return;
    setPasskeyResults([]);
    // parseExport is async but is not awaited here; typed any so the code stays as it is (see PR notes)
    /** @type {any} */
    let parsed;
    try {
      parsed = parseExport(await file.text());
    } catch (e) {
      return setPasskeyResults([{ label: file.name, status: "failed", reason: e?.message || "" }]);
    }
    const results = parsed.skipped.map((/** @type {{ label: string, reason: string }} */ s) => ({ label: s.label, status: "skipped", reason: s.reason }));
    const total = parsed.records.length;
    for (let i = 0; i < total; i++) {
      setPasskeyProgress({ done: i, total });
      const rec = parsed.records[i];
      const label = `${rec.rpId} / ${rec.userName}`;
      /** @type {{ ok?: boolean, result?: string, error?: string } | null} */
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: "passkeySave", record: rec });
      } catch {}
      if (res?.ok && (res.result === "saved" || res.result === "exists")) results.push({ label, status: res.result });
      else results.push({ label, status: "failed", reason: res?.error || res?.result || "" });
    }
    setPasskeyProgress(null);
    setPasskeyResults(results);
  }

  function saveBlurList() {
    if (!isBlurListDirty.current) return;
    isBlurListDirty.current = false;
    persist({ [BLUR_SAVED_LIST]: domainLines(listsRef.current[BLUR_SAVED_LIST]) });
  }

  /** @param {any} r the native helper reply @param {string} message */
  function applyPolicy(r, message) {
    setHelpers((h) => ({ ...h, policy: r.missing ? "missing" : "present" }));
    if (r.missing) setPolicy({ hidden: false, message: "" });
    else setPolicy((p) => ({ hidden: r.ok ? !!r.hidden : p.hidden, message }));
  }

  /** @param {Record<string, any>} partial */
  function persist(partial) {
    setSettings((s) => ({ ...s, ...partial }));
    queueSettings(partial);
  }

  /** @param {Record<string, any>} partial */
  function onChange(partial) {
    persist(partial);
    if ("theme" in partial) flushSettings();
  }

  /** @param {string} key @param {string} text */
  function onListChange(key, text) {
    setLists((l) => ({ ...l, [key]: text }));
    if (key === BLUR_SAVED_LIST) isBlurListDirty.current = true;
    else persist({ [key]: domainLines(text) });
  }

  /** @param {string} key */
  function onListBlur(key) {
    if (key === BLUR_SAVED_LIST) return saveBlurList();
    setLists((l) => ({ ...l, [key]: domainLines(l[key]).join("\n") }));
  }

  function onClearMru() {
    chrome.storage.local.remove("mru:v1").then(() => setIsMruCleared(true), () => {});
  }

  /** @param {boolean} isOn */
  async function onPolicy(isOn) {
    const r = await sendPolicy(isOn ? "set" : "clear");
    applyPolicy(r, policyMessage(r, true));
  }

  /** @param {"bubble" | "address"} key @param {boolean} isOn */
  function onPrivacy(key, isOn) {
    if (key === "bubble") setPrivacy("passwordSavingEnabled", isOn, setBubble, "suppressSaveBubble");
    else setPrivacy("autofillAddressEnabled", isOn, setAddress, "suppressAddressAutofill");
  }

  return (
    <div className="min-h-screen bg-[color-mix(in_srgb,CanvasText_3%,Canvas)]">
      <OptionsScreen
        tab={tab}
        isSettled={isLoaded && helpers.policy !== "checking" && helpers.updater !== "checking"}
        settings={settings}
        onChange={onChange}
        lists={lists}
        onListChange={onListChange}
        onListBlur={onListBlur}
        isMruCleared={isMruCleared}
        onClearMru={onClearMru}
        view={helperView({ helpers, isWindows: IS_WINDOWS, canCheckForUpdates: settings.canCheckForUpdates, relay })}
        policy={policy}
        onPolicy={onPolicy}
        privacy={{ bubble, address }}
        onPrivacy={onPrivacy}
        agentLog={agentLog}
        onCheckNow={() => chrome.tabs.create({ url: chrome.runtime.getURL(UPDATE_PAGE) })}
        passkeys={passkeysView(IS_WINDOWS)}
        passkeyStore={IS_WINDOWS ? { isOn: passkeyOn, onToggle: onPasskeyToggle, onPick: onPasskeyPick, progress: passkeyProgress, results: passkeyResults, note: passkeyNote, allSites, onAllSites, stayUnlocked, onStayUnlocked, syncSteps, onSyncAll } : null}
        onOpenUrl={(/** @type {string} */ url) => chrome.tabs.create({ url })}
        onShortcuts={() => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}
        onPasswordSettings={IS_EDGE ? null : () => chrome.tabs.create({ url: "chrome://password-manager/settings" })}
      />
    </div>
  );
}

/**
 * @param {string} action
 * @returns {Promise<any>} the native helper reply, or { error, missing }
 */
function sendPolicy(action) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage("com.passbridge.policy", { action }, (resp) => {
        // only a missing host means the helper isn't installed, other errors keep the toggle
        const err = chrome.runtime.lastError?.message;
        if (err) resolve({ error: err, missing: /not found|forbidden|native messaging host/i.test(err) });
        else resolve(resp || { error: "no reply" });
      });
    } catch (err) {
      resolve({ error: String(err) });
    }
  });
}

/** @param {string} name @param {(row: { shown: boolean, checked: boolean, disabled: boolean }) => void} setRow */
function readPrivacy(name, setRow) {
  const pref = /** @type {any} */ (chrome.privacy?.services)?.[name];
  if (!pref?.get) return;
  pref.get({}, (/** @type {any} */ d) => { // chrome.privacy details
    if (chrome.runtime.lastError || !d) return;
    const controllable = d.levelOfControl === "controllable_by_this_extension" || d.levelOfControl === "controlled_by_this_extension";
    setRow({ shown: true, checked: d.value === false, disabled: !controllable });
  });
}

// sync allows 120 writes a minute, and the domain lists save on every keystroke: batch them
let pendingSettings = {};
let flushTimer = 0;
/** @param {Record<string, any>} partial */
function queueSettings(partial) {
  Object.assign(pendingSettings, partial);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSettings, 600);
}
function flushSettings() {
  clearTimeout(flushTimer);
  if (!Object.keys(pendingSettings).length) return;
  const partial = pendingSettings;
  pendingSettings = {};
  settingsStore().set(partial, () => {
    if (chrome.runtime.lastError) console.warn("PassBridge: settings not saved", chrome.runtime.lastError.message);
  });
}

/** @param {string} name @param {boolean} on @param {(row: { shown: boolean, checked: boolean, disabled: boolean }) => void} setRow @param {string} storageKey */
function setPrivacy(name, on, setRow, storageKey) {
  const pref = /** @type {any} */ (chrome.privacy?.services)?.[name];
  if (!pref) return;
  settingsStore().set({ [storageKey]: on });
  const done = () => readPrivacy(name, setRow);
  if (on) pref.set({ value: false }, done);
  else pref.clear({}, done);
}

followTheme();
void applyDocumentLanguage(document, "settingsTitle");
createRoot(/** @type {HTMLElement} */ (document.getElementById("root"))).render(<OptionsApp />);
