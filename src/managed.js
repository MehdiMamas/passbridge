// an empty file `managed-install` next to manifest.json marks an install whose updates a package manager or MDM owns.
// kept out of settings.js so it is not bundled into content.js
import { getSettings } from "./settings.js";

const RECHECK_MS = 60 * 1000;

/** @type {boolean} */
let found = false;
let checkedAt = -Infinity;

export function resetManagedCache() {
  found = false;
  checkedAt = -Infinity;
}

/**
 * a true answer is kept, a false one is looked up again after 60 s
 * @param {{ fetchFn?: typeof fetch, getUrl?: (path: string) => string, now?: () => number }} [env]
 * @returns {Promise<boolean>}
 */
export async function isManagedInstall({ fetchFn = (...a) => fetch(...a), getUrl = (p) => chrome.runtime.getURL(p), now = Date.now } = {}) {
  if (found) return true;
  const t = now();
  if (t - checkedAt < RECHECK_MS) return false;
  checkedAt = t;
  try {
    found = (await fetchFn(getUrl("managed-install"))).ok;
  } catch {
    found = false;
  }
  return found;
}

/**
 * @template {{ canCheckForUpdates?: boolean, autoInstallUpdates?: boolean }} S
 * @param {S} settings
 * @param {boolean} managed
 * @returns {S}
 */
export function applyManaged(settings, managed) {
  return managed ? { ...settings, canCheckForUpdates: false, autoInstallUpdates: false } : settings;
}

export async function getEffectiveSettings() {
  return applyManaged(await getSettings(), await isManagedInstall());
}
