// the unpacked build never updates itself, so once a day the latest GitHub release is compared with the manifest

import { getSettings } from "./settings.js";
import { REPORT_REPO } from "./report-scrub.js";

export const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPORT_REPO}/releases/latest`;

export function releasePageUrl(tag) {
  return `https://github.com/${REPORT_REPO}/releases/tag/${encodeURIComponent(tag)}`;
}

function parseVersion(tag) {
  const m = /^v?(\d+(?:\.\d+){0,3})$/.exec(String(tag ?? "").trim());
  return m ? m[1].split(".").map(Number) : null;
}

export function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// a failed request leaves updateCheckedAt alone so the next alarm retries, a refused one waits a day
async function runCheck(now, force) {
  if (!(await getSettings()).canCheckForUpdates) return false;
  const { updateCheckedAt } = await chrome.storage.local.get("updateCheckedAt");
  const age = now - (Number(updateCheckedAt) || 0);
  if (!force && age >= 0 && age < UPDATE_CHECK_MS) return false;
  let res;
  try {
    res = await fetch(LATEST_RELEASE_URL, { headers: { Accept: "application/vnd.github+json" } });
  } catch {
    return false;
  }
  const body = res.ok ? await res.json().catch(() => null) : null;
  const tag = body?.tag_name;
  await chrome.storage.local.set(parseVersion(tag) ? { updateCheckedAt: now, latestRelease: tag } : { updateCheckedAt: now });
  return res.ok;
}

let running = null;
// force skips the daily wait (a button press); resolves true when GitHub answered.
// storage calls fail with "No SW" while the worker shuts down for a reload, the next alarm checks again
export function checkForUpdate(now = Date.now(), { force = false } = {}) {
  running ||= runCheck(now, force)
    .catch(() => false)
    .finally(() => {
      running = null;
    });
  return running;
}

/** @returns {Promise<{ version: string, url: string } | null>} */
export async function availableUpdate(currentVersion = chrome.runtime.getManifest().version) {
  if (!(await getSettings()).canCheckForUpdates) return null;
  const { latestRelease, dismissedRelease } = await chrome.storage.local.get(["latestRelease", "dismissedRelease"]);
  if (latestRelease === dismissedRelease || !isNewerVersion(latestRelease, currentVersion)) return null;
  return {
    version: parseVersion(latestRelease).join("."),
    url: releasePageUrl(latestRelease),
  };
}

export async function dismissUpdate() {
  const { latestRelease } = await chrome.storage.local.get("latestRelease");
  if (latestRelease) await chrome.storage.local.set({ dismissedRelease: latestRelease });
}
