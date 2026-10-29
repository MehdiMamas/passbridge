import { SETTINGS_AREA, SETTINGS_DEFAULTS, colorSchemeFor, settingsStore } from "../settings.js";

const CACHE_KEY = "pbTheme";

export function followTheme() {
  const root = document.documentElement;
  const apply = (theme) => {
    root.style.colorScheme = colorSchemeFor(theme);
    try {
      localStorage.setItem(CACHE_KEY, theme);
    } catch {}
  };
  try {
    root.style.colorScheme = colorSchemeFor(localStorage.getItem(CACHE_KEY));
  } catch {}
  settingsStore().get({ theme: SETTINGS_DEFAULTS.theme }, (o) => apply(o?.theme || SETTINGS_DEFAULTS.theme));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === SETTINGS_AREA && changes.theme) apply(changes.theme.newValue || SETTINGS_DEFAULTS.theme);
  });
}
