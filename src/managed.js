// managed.json next to manifest.json ships as {"managed": false}; a package manager or MDM that owns updates sets it to true.
// the file always exists, so reading it never logs a failed request
// kept out of settings.js so it is not bundled into content.js
import { getSettings } from "./settings.js";

const RECHECK_MS = 60 * 1000;

/** @type {boolean} */
let found = false;
let checkedAt = -Infinity;
/** @type {Promise<boolean> | null} */
let pending = null;

export function resetManagedCache() {
  found = false;
  checkedAt = -Infinity;
  pending = null;
}

/**
 * a true answer is kept, a false one is looked up again after 60 s
 * @param {{ fetchFn?: typeof fetch, getUrl?: (path: string) => string, now?: () => number }} [env]
 * @returns {Promise<boolean>}
 */
export async function isManagedInstall({ fetchFn = (...a) => fetch(...a), getUrl = (p) => chrome.runtime.getURL(p), now = Date.now } = {}) {
  if (found) return true;
  // a lookup in flight: wait for its answer instead of reporting false
  if (pending) return pending;
  const t = now();
  if (t - checkedAt < RECHECK_MS) return false;
  checkedAt = t;
  pending = (async () => {
    try {
      const res = await fetchFn(getUrl("managed.json"));
      found = res.ok && (await res.json())?.managed === true;
    } catch {
      found = false;
    }
    return found;
  })().finally(() => {
    pending = null;
  });
  return pending;
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
