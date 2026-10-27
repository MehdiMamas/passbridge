// User-facing defaults, the one copy: background imports it, content.js gets it bundled,
// options.jsx reads and writes against it.

export const SETTINGS_DEFAULTS = {
  inlineMenuVisibility: "on-focus",
  autofillOnPageLoad: false,
  // plain-http pages are refused unless the user opts in
  canFillOnHttp: false,
  copyTotpAfterFill: false,
  clipboardClearMs: 10000,
  enableContextMenu: true,
  enableBadge: true,
  askToSave: true,
  askToUpdate: true,
  excludedDomains: [],
  blockedDomains: [],
  showAnimations: true,
  showFavicons: true,
  hidePasskeys: false,
  // Chrome's own save-password bubble and address autofill, switched through chrome.privacy
  suppressSaveBubble: true,
  suppressAddressAutofill: false,
  // a local program may ask to fill a login or code on these sites, never reads a secret
  agentSignIn: false,
  agentAllowlist: ["github.com", "google.com", "vercel.com", "apple.com"],
  canCheckForUpdates: true,
};

// settings follow the Chrome profile to every signed-in machine; machine state stays in local
export const SETTINGS_AREA = "sync";
export const settingsStore = () => chrome.storage[SETTINGS_AREA];

// one-time move of a machine's local settings into sync; values already in sync win
export async function migrateSettingsToSync() {
  const keys = Object.keys(SETTINGS_DEFAULTS);
  const local = await chrome.storage.local.get(keys);
  if (!Object.keys(local).length) return;
  const synced = await settingsStore().get(keys);
  if (!Object.keys(synced).length) await settingsStore().set(local);
  await chrome.storage.local.remove(keys);
}

export function getSettings() {
  return new Promise((resolve) => {
    settingsStore().get(SETTINGS_DEFAULTS, (o) => {
      const settings = chrome.runtime.lastError
        ? { ...SETTINGS_DEFAULTS }
        : { ...SETTINGS_DEFAULTS, ...o };
      if (!Number(settings.clipboardClearMs)) settings.clipboardClearMs = SETTINGS_DEFAULTS.clipboardClearMs;
      resolve(settings);
    });
  });
}

export function hostBlocked(host, list) {
  host = (host || "").toLowerCase();
  return (list || []).some((d) => {
    d = String(d || "").trim().toLowerCase();
    if (!d) return false;
    return host === d || host.endsWith("." + d);
  });
}
