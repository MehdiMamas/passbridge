// User-facing defaults. Content scripts repeat this object because they are not modules.

export const SETTINGS_DEFAULTS = {
  inlineMenuVisibility: "on-focus",
  autofillOnPageLoad: false,
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
