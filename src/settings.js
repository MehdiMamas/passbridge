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
};

export function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_DEFAULTS, (o) => {
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
