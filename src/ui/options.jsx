import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SETTINGS_DEFAULTS as DEFAULTS, settingsStore } from "../settings.js";
import { UPDATE_PAGE } from "../update/check.js";
import { updaterAvailable } from "../update/install.js";
import { isWindows } from "../update/platform.js";
import { helperView, policyMessage, tabFromHash } from "./options-model.js";
import { OptionsScreen } from "./options-screen.jsx";
import { followTheme } from "./page-theme.js";

const LIST_KEYS = ["blockedDomains", "excludedDomains", "agentAllowlist"];
const BLUR_SAVED_LIST = "agentAllowlist";
const IS_WINDOWS = isWindows();
const IS_EDGE = !!navigator.userAgentData?.brands?.some((b) => b.brand === "Microsoft Edge");

function OptionsApp() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [isLoaded, setIsLoaded] = useState(false);
  const [lists, setLists] = useState(() => Object.fromEntries(LIST_KEYS.map((k) => [k, ""])));
  const [agentLog, setAgentLog] = useState([]);
  const [tab, setTab] = useState(() => tabFromHash(location.hash));
  const [helpers, setHelpers] = useState({ policy: "checking", updater: "checking" });
  const [policy, setPolicy] = useState({ hidden: false, message: "" });
  const [bubble, setBubble] = useState({ shown: false, checked: false, disabled: true });
  const [address, setAddress] = useState({ shown: false, checked: false, disabled: true });
  const listsRef = useRef(lists);
  const isBlurListDirty = useRef(false);
  listsRef.current = lists;

  useEffect(() => {
    settingsStore().get(DEFAULTS, (saved) => {
      const next = { ...DEFAULTS, ...saved };
      if (!Number(next.clipboardClearMs)) {
        next.clipboardClearMs = DEFAULTS.clipboardClearMs;
        settingsStore().set({ clipboardClearMs: next.clipboardClearMs });
      }
      setSettings(next);
      setIsLoaded(true);
      setLists(Object.fromEntries(LIST_KEYS.map((k) => [k, (next[k] || []).join("\n")])));
    });
    chrome.storage.local.get({ agentLog: [] }, (o) => setAgentLog(Array.isArray(o.agentLog) ? o.agentLog : []));
    const onLog = (changes, area) => {
      if (area === "local" && changes.agentLog) setAgentLog(changes.agentLog.newValue || []);
    };
    chrome.storage.onChanged.addListener(onLog);
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
      removeEventListener("hashchange", onHash);
      removeEventListener("pagehide", onPageHide);
      onPageHide();
    };
  }, []);

  function saveBlurList() {
    if (!isBlurListDirty.current) return;
    isBlurListDirty.current = false;
    persist({ [BLUR_SAVED_LIST]: domainLines(listsRef.current[BLUR_SAVED_LIST]) });
  }

  function applyPolicy(r, message) {
    setHelpers((h) => ({ ...h, policy: r.missing ? "missing" : "present" }));
    if (r.missing) setPolicy({ hidden: false, message: "" });
    else setPolicy((p) => ({ hidden: r.ok ? !!r.hidden : p.hidden, message }));
  }

  function persist(partial) {
    setSettings((s) => ({ ...s, ...partial }));
    queueSettings(partial);
  }

  function onChange(partial) {
    persist(partial);
    if ("theme" in partial) flushSettings();
  }

  function onListChange(key, text) {
    setLists((l) => ({ ...l, [key]: text }));
    if (key === BLUR_SAVED_LIST) isBlurListDirty.current = true;
    else persist({ [key]: domainLines(text) });
  }

  function onListBlur(key) {
    if (key === BLUR_SAVED_LIST) return saveBlurList();
    setLists((l) => ({ ...l, [key]: domainLines(l[key]).join("\n") }));
  }

  async function onPolicy(isOn) {
    const r = await sendPolicy(isOn ? "set" : "clear");
    applyPolicy(r, policyMessage(r, true));
  }

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
        view={helperView({ helpers, isWindows: IS_WINDOWS, canCheckForUpdates: settings.canCheckForUpdates })}
        policy={policy}
        onPolicy={onPolicy}
        privacy={{ bubble, address }}
        onPrivacy={onPrivacy}
        agentLog={agentLog}
        onCheckNow={() => chrome.tabs.create({ url: chrome.runtime.getURL(UPDATE_PAGE) })}
        onShortcuts={() => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}
        onPasswordSettings={IS_EDGE ? null : () => chrome.tabs.create({ url: "chrome://password-manager/settings" })}
      />
    </div>
  );
}

// hostBlocked compares bare hostnames, so https://example.com/ or *.example.com would never match
function domainLines(value) {
  const out = [];
  for (const line of value.split(/[\n,]+/)) {
    const d = line
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "")
      .replace(/^\*\./, "")
      .replace(/^\.+|\.+$/g, "");
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

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

function readPrivacy(name, setRow) {
  const pref = chrome.privacy?.services?.[name];
  if (!pref?.get) return;
  pref.get({}, (d) => {
    if (chrome.runtime.lastError || !d) return;
    const controllable = d.levelOfControl === "controllable_by_this_extension" || d.levelOfControl === "controlled_by_this_extension";
    setRow({ shown: true, checked: d.value === false, disabled: !controllable });
  });
}

// sync allows 120 writes a minute, and the domain lists save on every keystroke: batch them
let pendingSettings = {};
let flushTimer = 0;
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

function setPrivacy(name, on, setRow, storageKey) {
  const pref = chrome.privacy?.services?.[name];
  if (!pref) return;
  settingsStore().set({ [storageKey]: on });
  const done = () => readPrivacy(name, setRow);
  if (on) pref.set({ value: false }, done);
  else pref.clear({}, done);
}

followTheme();
createRoot(document.getElementById("root")).render(<OptionsApp />);
